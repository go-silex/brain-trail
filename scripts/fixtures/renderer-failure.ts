import { DomRenderer, type VNode } from '../../hosts/browser/dom'

// Exercise the production renderer in a connected browser DOM. The getter
// throws an unrelated application error after an observer-owning sibling.
Object.assign(window, {
  rendererFailureProof: async () => {
    const results: string[] = []
    const box = (
      key: string,
      children: (VNode | string)[] = [],
      props: object = {},
    ): VNode => ({
      kind: 'box',
      key,
      props: { key, ...props },
      children,
    })
    const broken = (error: Error): VNode => ({
      kind: 'box',
      key: 'broken',
      children: [],
      props: new Proxy(
        { key: 'broken' },
        {
          get(target, property, receiver) {
            if (property === 'flexDirection') throw error
            return Reflect.get(target, property, receiver)
          },
        },
      ),
    })
    const frame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    const NativeObserver = window.ResizeObserver
    const targets: Element[] = []
    window.ResizeObserver = class extends NativeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        targets.push(target)
        super.observe(target, options)
      }
    }
    try {
      for (const mode of ['initial', 'replacement', 'retained']) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        let resizes = 0
        const renderer = new DomRenderer(container, {
          gesture: () => null,
          wheel: () => false,
          resize: () => {
            resizes++
          },
        })
        const observed = () => box('map-wrap', [], { width: 10, height: 10 })
        if (mode !== 'initial') {
          renderer.render(
            box('root', [box('nested', [observed(), box('old')])]),
          )
          await frame()
          if (!resizes)
            throw new Error(`${mode}: observer did not run while mounted`)
        }
        const retained = targets[0]
        targets.length = 0
        const error = new Error(`original-${mode}`)
        const tree =
          mode === 'initial'
            ? box('root', [observed(), broken(error)])
            : mode === 'replacement'
              ? box('root', [
                  box('nested', [
                    box('replacement', [observed()]),
                    broken(error),
                  ]),
                ])
              : box('root', [box('nested', [observed(), broken(error)])])
        let thrown: unknown
        try {
          renderer.render(tree)
        } catch (caught) {
          thrown = caught
        }
        if (thrown !== error)
          throw new Error(`${mode}: original error was not preserved`)
        if (container.childNodes.length !== 0)
          throw new Error(`${mode}: failed tree remained mounted`)
        const detached = mode === 'retained' ? retained : targets[0]
        if (!detached) throw new Error(`${mode}: missing observed element`)
        const count = resizes
        document.body.appendChild(detached)
        ;(detached as HTMLElement).style.width = '321px'
        await frame()
        if (resizes !== count)
          throw new Error(`${mode}: disposed observer continued work`)
        detached.remove()
        renderer.render(box('recovered', ['recovered']))
        if (
          container.textContent !== 'recovered' ||
          container.children.length !== 1
        )
          throw new Error(`${mode}: subsequent render did not start cleanly`)
        renderer.dispose()
        container.remove()
        targets.length = 0
        results.push(mode)
      }
    } finally {
      window.ResizeObserver = NativeObserver
    }
    return results
  },
})
