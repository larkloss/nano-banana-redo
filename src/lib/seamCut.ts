// Optimal seam for pasting part of one picture into another ("photomontage"
// style). Given
//   - `must`:  pixels that have to come from the new picture (the change),
//   - `may`:   pixels that are allowed to (a band around the change),
//   - `cost`:  how different the two pictures are at each pixel,
// it returns the region `must ⊆ region ⊆ may` whose boundary runs where the
// two pictures agree most, i.e. where a seam is least visible. That is a
// minimum s-t cut on the pixel grid: `must` is tied to the source, everything
// outside `may` to the sink, and cutting between neighbours p,q costs the
// average of their costs (plus a small length penalty).

export function optimalSeamRegion(
  must: Uint8Array,
  may: Uint8Array,
  cost: Float32Array,
  w: number,
  h: number,
  lengthPenalty = 1,
  // Charged for every band pixel taken from the new picture. Keeps the cut
  // from drifting inward around holes (a shorter loop is otherwise always
  // "cheaper") and from taking more of the new picture than it needs.
  takeCost = 0.3,
): Uint8Array {
  const n = w * h
  // Band pixels get graph node ids; must → source, outside may → sink
  const node = new Int32Array(n).fill(-1)
  let count = 0
  for (let p = 0; p < n; p++) if (may[p] && !must[p]) node[p] = count++
  const region = new Uint8Array(n)
  for (let p = 0; p < n; p++) region[p] = must[p]
  if (count === 0) return region

  const S = count
  const T = count + 1
  const graph = new FlowGraph(count + 2, count * 6 + 16)
  const weight = (p: number, q: number) => (cost[p] + cost[q]) * 0.5 + lengthPenalty

  for (let p = 0; p < n; p++) {
    const u = node[p]
    if (u < 0) continue
    const x = p % w
    // right and down neighbours (each undirected edge once), plus links to
    // source/sink for neighbours on either side of the band
    const neighbours: number[] = []
    if (x < w - 1) neighbours.push(p + 1)
    if (x > 0) neighbours.push(p - 1)
    if (p >= w) neighbours.push(p - w)
    if (p < n - w) neighbours.push(p + w)
    let toSource = 0
    let toSink = 0
    for (const q of neighbours) {
      const v = node[q]
      if (v >= 0) {
        if (q > p) graph.addEdge(u, v, weight(p, q), weight(p, q))
      } else if (must[q]) {
        toSource += weight(p, q)
      } else {
        toSink += weight(p, q)
      }
    }
    // The picture's own frame isn't a seam: a band pixel on the image border
    // has no neighbour there, so nothing is added for it
    if (toSource > 0) graph.addEdge(S, u, toSource, 0)
    if (toSink + takeCost > 0) graph.addEdge(u, T, toSink + takeCost, 0)
  }

  graph.maxFlow(S, T)
  const reachable = graph.sourceSide(S)
  for (let p = 0; p < n; p++) {
    const u = node[p]
    if (u >= 0 && reachable[u]) region[p] = 1
  }
  return region
}

// Dinic's max-flow on a compact edge list
class FlowGraph {
  private head: Int32Array
  private next: Int32Array
  private to: Int32Array
  private cap: Float64Array
  private edges = 0
  private level: Int32Array
  private iter: Int32Array
  private nodes: number

  constructor(nodes: number, edgeHint: number) {
    this.nodes = nodes
    this.head = new Int32Array(nodes).fill(-1)
    this.next = new Int32Array(edgeHint * 2)
    this.to = new Int32Array(edgeHint * 2)
    this.cap = new Float64Array(edgeHint * 2)
    this.level = new Int32Array(nodes)
    this.iter = new Int32Array(nodes)
  }

  addEdge(u: number, v: number, c: number, reverseCap: number): void {
    if (this.edges + 2 > this.to.length) this.grow()
    this.to[this.edges] = v
    this.cap[this.edges] = c
    this.next[this.edges] = this.head[u]
    this.head[u] = this.edges++
    this.to[this.edges] = u
    this.cap[this.edges] = reverseCap
    this.next[this.edges] = this.head[v]
    this.head[v] = this.edges++
  }

  private grow(): void {
    const size = this.to.length * 2
    const grow32 = (a: Int32Array) => {
      const b = new Int32Array(size)
      b.set(a)
      return b
    }
    this.next = grow32(this.next)
    this.to = grow32(this.to)
    const cap = new Float64Array(size)
    cap.set(this.cap)
    this.cap = cap
  }

  maxFlow(s: number, t: number): number {
    let flow = 0
    const EPS = 1e-9
    const queue = new Int32Array(this.nodes)
    // Iterative DFS state
    const stackNode = new Int32Array(this.nodes)
    const stackEdge = new Int32Array(this.nodes)

    for (;;) {
      // BFS levels
      this.level.fill(-1)
      let qh = 0
      let qt = 0
      queue[qt++] = s
      this.level[s] = 0
      while (qh < qt) {
        const u = queue[qh++]
        for (let e = this.head[u]; e !== -1; e = this.next[e]) {
          if (this.cap[e] > EPS && this.level[this.to[e]] < 0) {
            this.level[this.to[e]] = this.level[u] + 1
            queue[qt++] = this.to[e]
          }
        }
      }
      if (this.level[t] < 0) return flow
      this.iter.set(this.head)

      // Blocking flow: repeatedly find an s→t path in the level graph
      for (;;) {
        let depth = 0
        stackNode[0] = s
        let found = false
        while (depth >= 0) {
          const u = stackNode[depth]
          if (u === t) {
            found = true
            break
          }
          let advanced = false
          for (; this.iter[u] !== -1; this.iter[u] = this.next[this.iter[u]]) {
            const e = this.iter[u]
            const v = this.to[e]
            if (this.cap[e] > EPS && this.level[v] === this.level[u] + 1) {
              stackEdge[depth] = e
              stackNode[++depth] = v
              advanced = true
              break
            }
          }
          if (!advanced) {
            // dead end: retreat and skip the edge that led here
            this.level[u] = -1
            depth--
            if (depth >= 0) {
              const pu = stackNode[depth]
              this.iter[pu] = this.next[this.iter[pu]]
            }
          }
        }
        if (!found) break
        let bottleneck = Infinity
        for (let i = 0; i < depth; i++) bottleneck = Math.min(bottleneck, this.cap[stackEdge[i]])
        for (let i = 0; i < depth; i++) {
          this.cap[stackEdge[i]] -= bottleneck
          this.cap[stackEdge[i] ^ 1] += bottleneck
        }
        flow += bottleneck
      }
    }
  }

  // Nodes still reachable from s in the residual graph = the source side of
  // the minimum cut
  sourceSide(s: number): Uint8Array {
    const seen = new Uint8Array(this.nodes)
    const stack = [s]
    seen[s] = 1
    while (stack.length > 0) {
      const u = stack.pop()!
      for (let e = this.head[u]; e !== -1; e = this.next[e]) {
        const v = this.to[e]
        if (this.cap[e] > 1e-9 && !seen[v]) {
          seen[v] = 1
          stack.push(v)
        }
      }
    }
    return seen
  }
}
