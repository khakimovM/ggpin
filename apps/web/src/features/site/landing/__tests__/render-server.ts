import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

// A server component may be `async`, which a client renderer (Testing Library) cannot draw. This
// runs every async component of a tree to its result and leaves the rest as it is, so a page
// section built from async parts can be rendered whole in a unit test.
const isAsync = (type: unknown): type is (props: unknown) => Promise<ReactNode> =>
  typeof type === 'function' && Object.prototype.toString.call(type) === '[object AsyncFunction]';

export async function settleServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node))
    return Promise.all(node.map((child: ReactNode) => settleServerTree(child)));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  const component: unknown = node.type;
  if (isAsync(component)) {
    const result: ReactNode = await component(node.props);
    return settleServerTree(result);
  }
  const { children } = node.props;
  if (children === undefined) return node;
  // `Children.toArray` keys every child (as React itself would), and they go back as separate
  // arguments: a bare array as the one child would warn "each child in a list should have a unique
  // key" for children that were never a list.
  const settled = await Promise.all(
    Children.toArray(children).map((child) => settleServerTree(child)),
  );
  return cloneElement(node, undefined, ...settled);
}
