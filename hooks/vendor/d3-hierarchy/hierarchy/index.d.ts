export type HierarchyNode<T> = {
  data: T; depth: number; value?: number; x: number; y: number; r: number
  children?: HierarchyNode<T>[]
  sum(value: (d: T) => number): HierarchyNode<T>
  sort(compare: (a: HierarchyNode<T>, b: HierarchyNode<T>) => number): HierarchyNode<T>
  descendants(): HierarchyNode<T>[]
  leaves(): HierarchyNode<T>[]
}
export default function hierarchy<T>(data: T, children?: (d: T) => Iterable<T> | undefined): HierarchyNode<T>
