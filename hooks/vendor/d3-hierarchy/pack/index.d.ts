import type { HierarchyNode } from '../hierarchy/index.js'
export type Pack = {
  <T>(root: HierarchyNode<T>): HierarchyNode<T>
  size(size: [number, number]): Pack
  padding(padding: number | ((node: HierarchyNode<any>) => number)): Pack
}
export default function pack(): Pack
