type Child = Node | string | number | null | undefined | false;

/**
 * Tiny element factory. Strings are always inserted as text nodes (never HTML),
 * so values that come from the chain or from URLs cannot inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = String(value);
    else if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Drops null / undefined / false so conditional children can be passed to append() and replaceChildren(). */
export function compact(items: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return items.filter((item): item is Node | string => item !== null && item !== undefined && item !== false);
}
