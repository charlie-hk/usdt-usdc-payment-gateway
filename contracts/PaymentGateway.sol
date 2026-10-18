// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PaymentGateway
 * @notice Invoice-based ERC-20 payment gateway for stablecoins (USDT / USDC).
 *
 * Flow:
 *   1. A merchant creates an invoice (token, amount, optional expiry).
 *   2. A customer pays it with `pay` (after `approve`) or, for tokens that
 *      implement EIP-2612 such as USDC, with `payWithPermit` in one transaction.
 *   3. Funds are credited to the merchant's internal balance (minus the
 *      protocol fee) and the merchant pulls them out with `withdraw`.
 *
 * Design notes:
 *   - Pull-payment accounting: a payment never sends tokens to the merchant, so
 *     a blocklisted or reverting merchant address cannot block a payer, and
 *     withdrawals are never blocked by `pause`.
 *   - SafeERC20 is used everywhere so non-standard tokens such as mainnet USDT
 *     (no return value on transfer / transferFrom / approve) work.
 *   - Fee-on-transfer tokens are rejected: the amount actually received must
 *     equal the invoice amount. Mainnet USDT has a dormant fee switch, so this
 *     protects the accounting if it is ever turned on.
 *   - `totalHeld` tracks what the contract owes to merchants and to the fee
 *     recipient, so tokens sent here by mistake can be swept without ever
 *     touching customer funds.
 */
contract PaymentGateway is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum Status {
        None,
        Pending,
        Paid,
        Cancelled
    }

    struct Invoice {
        address merchant; // slot 0
        uint64 expiresAt; // 0 = never expires
        Status status;
        address token; // slot 1
        uint64 paidAt;
        address payer; // slot 2
        uint256 amount; // slot 3, in the token's smallest unit
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint16 public constant MAX_FEE_BPS = 500; // 5%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint256 public invoiceCount;
    uint16 public feeBps;

    mapping(address token => bool) public supportedToken;
    mapping(uint256 invoiceId => Invoice) private _invoices;

    /// @notice Withdrawable balance per merchant and token (already net of fee).
    mapping(address merchant => mapping(address token => uint256)) public merchantBalance;
    /// @notice Accrued protocol fees per token.
    mapping(address token => uint256) public feeBalance;
    /// @notice Sum of every balance the contract owes, per token.
    mapping(address token => uint256) public totalHeld;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed token,
        uint256 amount,
        uint64 expiresAt,
        bytes32 orderRef
    );
    event InvoicePaid(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        address token,
        uint256 amount,
        uint256 fee
    );
    event InvoiceCancelled(uint256 indexed invoiceId, address indexed merchant);
    event Withdrawn(address indexed merchant, address indexed token, address to, uint256 amount);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event UnaccountedSwept(address indexed token, address indexed to, uint256 amount);
    event SupportedTokenSet(address indexed token, bool supported);
    event FeeBpsSet(uint16 feeBps);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error NotAContract(address account);
    error TokenNotSupported(address token);
    error ZeroAmount();
    error InvalidExpiry();
    error InvoiceNotFound(uint256 invoiceId);
    error InvoiceNotPending(uint256 invoiceId, Status status);
    error InvoiceExpired(uint256 invoiceId, uint64 expiresAt);
    error NotMerchant(uint256 invoiceId, address caller);
    error InsufficientBalance(uint256 requested, uint256 available);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error NothingToSweep();
    error RenounceDisabled();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address initialOwner, address[] memory initialTokens, uint16 initialFeeBps)
        Ownable(initialOwner)
    {
        for (uint256 i = 0; i < initialTokens.length; i++) {
            _setSupportedToken(initialTokens[i], true);
        }
        _setFeeBps(initialFeeBps);
    }

    /*//////////////////////////////////////////////////////////////
                              MERCHANT ACTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Create an invoice. The caller becomes the merchant.
     * @param token      Supported ERC-20 the customer must pay in.
     * @param amount     Amount in the token's smallest unit (6 decimals for USDT/USDC).
     * @param expiresAt  Unix timestamp after which the invoice cannot be paid, or 0 for none.
     * @param orderRef    Opaque merchant reference (e.g. hash of an order id), emitted only.
     */
    function createInvoice(address token, uint256 amount, uint64 expiresAt, bytes32 orderRef)
        external
        whenNotPaused
        returns (uint256 invoiceId)
    {
        if (!supportedToken[token]) revert TokenNotSupported(token);
        if (amount == 0) revert ZeroAmount();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();

        invoiceId = ++invoiceCount;
        _invoices[invoiceId] = Invoice({
            merchant: msg.sender,
            expiresAt: expiresAt,
            status: Status.Pending,
            token: token,
            paidAt: 0,
            payer: address(0),
            amount: amount
        });

        emit InvoiceCreated(invoiceId, msg.sender, token, amount, expiresAt, orderRef);
    }

    /// @notice Cancel a pending invoice. Only the merchant that created it can do this.
    function cancelInvoice(uint256 invoiceId) external {
        Invoice storage invoice = _invoices[invoiceId];
        if (invoice.status == Status.None) revert InvoiceNotFound(invoiceId);
        if (invoice.merchant != msg.sender) revert NotMerchant(invoiceId, msg.sender);
        if (invoice.status != Status.Pending) revert InvoiceNotPending(invoiceId, invoice.status);

        invoice.status = Status.Cancelled;
        emit InvoiceCancelled(invoiceId, msg.sender);
    }

    /// @notice Withdraw part of the caller's balance. Not affected by `pause`.
    function withdraw(address token, address to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = merchantBalance[msg.sender][token];
        if (amount > available) revert InsufficientBalance(amount, available);

        merchantBalance[msg.sender][token] = available - amount;
        totalHeld[token] -= amount;

        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, token, to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                              CUSTOMER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pay an invoice. The caller must have approved this contract for the invoice amount.
    function pay(uint256 invoiceId) external nonReentrant whenNotPaused {
        _pay(invoiceId);
    }

    /**
     * @notice Pay an invoice in a single transaction using an EIP-2612 permit (USDC).
     * @dev The permit call is wrapped in try/catch: if someone front-runs the
     *      transaction and consumes the signature first, the allowance is
     *      already in place and the payment still goes through. If the permit
     *      failed for any other reason, `transferFrom` reverts on allowance.
     */
    function payWithPermit(uint256 invoiceId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        whenNotPaused
    {
        Invoice storage invoice = _invoices[invoiceId];
        if (invoice.status == Status.None) revert InvoiceNotFound(invoiceId);

        try IERC20Permit(invoice.token).permit(msg.sender, address(this), invoice.amount, deadline, v, r, s) {}
        catch {}

        _pay(invoiceId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        Invoice memory invoice = _invoices[invoiceId];
        if (invoice.status == Status.None) revert InvoiceNotFound(invoiceId);
        return invoice;
    }

    /// @notice True if `pay` would currently accept this invoice (ignoring the payer's balance and allowance).
    function isPayable(uint256 invoiceId) external view returns (bool) {
        Invoice storage invoice = _invoices[invoiceId];
        return invoice.status == Status.Pending
            && (invoice.expiresAt == 0 || block.timestamp <= invoice.expiresAt)
            && supportedToken[invoice.token]
            && !paused();
    }

    /// @notice Fee that would be charged on `amount` at the current rate.
    function quoteFee(uint256 amount) public view returns (uint256) {
        return (amount * feeBps) / BPS_DENOMINATOR;
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setSupportedToken(address token, bool supported) external onlyOwner {
        _setSupportedToken(token, supported);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        _setFeeBps(newFeeBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraw accrued protocol fees.
    function withdrawFees(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = feeBalance[token];
        if (amount > available) revert InsufficientBalance(amount, available);

        feeBalance[token] = available - amount;
        totalHeld[token] -= amount;

        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    /// @notice Recover tokens that were transferred to the contract without going through `pay`.
    ///         Can never touch merchant balances or accrued fees.
    function sweepUnaccounted(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 held = totalHeld[token];
        if (balance <= held) revert NothingToSweep();

        uint256 excess = balance - held;
        IERC20(token).safeTransfer(to, excess);
        emit UnaccountedSwept(token, to, excess);
    }

    /// @dev Renouncing would strand accrued fees and lock admin functions forever.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _pay(uint256 invoiceId) private {
        Invoice storage invoice = _invoices[invoiceId];

        if (invoice.status == Status.None) revert InvoiceNotFound(invoiceId);
        if (invoice.status != Status.Pending) revert InvoiceNotPending(invoiceId, invoice.status);
        if (invoice.expiresAt != 0 && block.timestamp > invoice.expiresAt) {
            revert InvoiceExpired(invoiceId, invoice.expiresAt);
        }

        address token = invoice.token;
        if (!supportedToken[token]) revert TokenNotSupported(token);

        address merchant = invoice.merchant;
        uint256 amount = invoice.amount;
        uint256 fee = quoteFee(amount);

        // Effects
        invoice.status = Status.Paid;
        invoice.payer = msg.sender;
        invoice.paidAt = uint64(block.timestamp);

        merchantBalance[merchant][token] += amount - fee;
        if (fee != 0) feeBalance[token] += fee;
        totalHeld[token] += amount;

        // Interaction: measure what actually arrived to reject fee-on-transfer behaviour.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);

        emit InvoicePaid(invoiceId, merchant, msg.sender, token, amount, fee);
    }

    function _setSupportedToken(address token, bool supported) private {
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert NotAContract(token);
        supportedToken[token] = supported;
        emit SupportedTokenSet(token, supported);
    }

    function _setFeeBps(uint16 newFeeBps) private {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        feeBps = newFeeBps;
        emit FeeBpsSet(newFeeBps);
    }
}
