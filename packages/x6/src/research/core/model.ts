import { ObjectExt } from '../../util'
import { KeyValue } from '../../types'
import { Basecoat } from '../../entity'
import { Cell } from './cell'
import { Edge } from './edge'
import { Node } from './node'
import { Collection } from './collection'
import { Point, Rectangle } from '../../geometry'

export class Model extends Basecoat<Model.EventArgs> {
  public readonly collection: Collection
  protected readonly batches: KeyValue<number> = {}
  protected nodes: KeyValue<boolean> = {}
  protected edges: KeyValue<boolean> = {}
  protected in: KeyValue<KeyValue<boolean>> = {}
  protected out: KeyValue<KeyValue<boolean>> = {}

  constructor(cells: Cell[] = []) {
    super()

    this.collection = new Collection(cells, {
      comparator: (a, b) => {
        const za = a.zIndex || 0
        const zb = b.zIndex || 0
        return za - zb
      },
    })

    this.startListening()
  }

  protected startListening() {
    const collection = this.collection
    collection.on('sort', () => this.trigger('sort'))
    collection.on('update', args => this.trigger('change', args))
    collection.on('reset', args => {
      this.onReset(args.current)
      this.trigger('reset', args)
    })

    collection.on('add', args => {
      this.onCellAdded(args.cell)
      this.trigger('cell:added', args)
    })
    collection.on('remove', args => {
      this.onCellRemoved(args.cell, args.options)
      this.trigger('cell:removed', args)
    })
    collection.on('change', args => this.trigger('cell:changed', args))

    collection.on('change:terminal', this.onEdgeTerminalChanged, this)
  }

  protected onReset(cells: Cell[]) {
    this.out = {}
    this.in = {}
    this.nodes = {}
    this.edges = {}
    cells.forEach(cell => this.onCellAdded(cell))
  }

  protected sortOnChangeZ() {
    this.collection.sort()
  }

  protected onCellAdded(cell: Cell) {
    const cellId = cell.id
    if (cell.isEdge()) {
      this.edges[cellId] = true
      const source = cell.getSourceCell()
      const target = cell.getTargetCell()
      if (source) {
        const id = source.id
        if (!this.out[id]) {
          this.out[id] = {}
        }
        this.out[id][cellId] = true
      }
      if (target) {
        const id = target.id
        if (!this.in[id]) {
          this.in[id] = {}
        }
        this.in[id][cellId] = true
      }
    } else {
      this.nodes[cellId] = true
    }
  }

  protected onCellRemoved(cell: Cell, options: Collection.RemoveOptions) {
    const cellId = cell.id
    if (cell.isEdge()) {
      delete this.edges[cellId]
      const source = cell.getSourceCell()
      const target = cell.getTargetCell()
      if (source) {
        const id = source.id
        const tmp = this.out[id]
        if (tmp && tmp[cellId]) {
          delete tmp[cellId]
        }
      }
      if (target) {
        const id = target.id
        const tmp = this.in[id]
        if (tmp && tmp[cellId]) {
          delete tmp[cellId]
        }
      }
    } else {
      delete this.nodes[cellId]
    }
  }

  protected postprocessCell(cell: Cell, options: Collection.RemoveOptions) {
    if (!options.clear) {
      if (options.disconnectEdges) {
        this.disconnectEdges(cell, options)
      } else {
        this.removeEdges(cell, options)
      }
    }

    if (cell.model === this) {
      cell.model = null
    }
  }

  protected onEdgeTerminalChanged({
    edge,
    type,
  }: Collection.EventArgs['change:terminal']) {
    const edgeId = edge.id
    const isSource = type === 'source'
    const cache = isSource ? this.out : this.in
    const terminal = isSource ? edge.getSourceCell() : edge.getTargetCell()
    const previousData = edge.store.getPrevious(type) as Edge.TerminalCellData
    if (previousData.cellId) {
      const previousTerminal = this.getCell(previousData.cellId)
      if (previousTerminal && cache[previousTerminal.id]) {
        delete cache[previousTerminal.id][edgeId]
      }
    }

    if (terminal) {
      const id = terminal.id
      if (!cache[id]) {
        cache[id] = {}
      }
      cache[id][edgeId] = true
    }
  }

  clear(options: Cell.SetOptions = {}) {
    const raw = this.getCells()
    if (raw.length === 0) {
      return this
    }
    const localOptions = { ...options, clear: true }
    this.executeBatch(
      'clear',
      () => {
        // The nodes come after the edges.
        const cells = raw.sort(cell => (cell.isEdge() ? 1 : 2))
        while (cells.length > 0) {
          // Note that all the edges are removed first, so it's safe to
          // remove the nodes without removing the connected edges first.
          const cell = cells.shift()
          if (cell) {
            cell.remove(localOptions)
          }
        }
      },
      localOptions,
    )

    return this
  }

  protected prepareCell(cell: Cell, options: Collection.AddOptions) {
    if (!cell.model && (!options || !options.dry)) {
      // A cell can not be member of more than one graph.
      // A cell stops being the member of the graph after it's removed.
      cell.model = this
    }

    return cell
  }

  addCell(cell: Cell | Cell[], options: Collection.AddOptions = {}) {
    if (Array.isArray(cell)) {
      return this.addCells(cell, options)
    }

    if (cell.zIndex == null) {
      cell.zIndex = this.getMaxZIndex() + 1
    }

    this.collection.add(this.prepareCell(cell, options), options)

    return this
  }

  addCells(cells: Cell[], options: Collection.AddOptions = {}) {
    const count = cells.length
    if (count === 0) {
      return this
    }

    const localOptions = {
      ...options,
      position: count - 1,
      maxPosition: count - 1,
    }

    this.startBatch('add', localOptions)
    cells.forEach(cell => {
      this.addCell(cell, localOptions)
      localOptions.position -= 1
    })
    this.stopBatch('add', localOptions)

    return this
  }

  resetCells(cells: Cell[], options: Collection.SetOptions = {}) {
    const preparedCells = cells.map(cell => {
      return this.prepareCell(cell, options)
    })
    this.collection.reset(preparedCells, options)

    return this
  }

  removeCells(cells: Cell[], options: Cell.RemoveOptions = {}) {
    if (cells.length) {
      this.executeBatch('remove', () => {
        cells.forEach(cell => cell.remove(options))
      })
    }
    return this
  }

  removeEdges(cell: Cell | string, options: Cell.RemoveOptions = {}) {
    this.getConnectedEdges(cell).forEach(edge => {
      edge.remove(options)
    })
  }

  disconnectEdges(cell: Cell | string, options: Edge.SetOptions) {
    const cellId = typeof cell === 'string' ? cell : cell.id
    this.getConnectedEdges(cell).forEach(edge => {
      const sourceCell = edge.getSourceCell()
      const targetCell = edge.getTargetCell()

      if (sourceCell && sourceCell.id === cellId) {
        edge.setSource({ x: 0, y: 0 }, options)
      }

      if (targetCell && targetCell.id === cellId) {
        edge.setTarget({ x: 0, y: 0 }, options)
      }
    })
  }

  /**
   * Returns a cell from the graph by its id.
   */
  getCell<T extends Cell = Cell>(id: string) {
    return this.collection.get(id) as T
  }

  /**
   * Returns all the nodes and edges in the graph.
   */
  getCells() {
    return this.collection.toArray()
  }

  /**
   * Returns the first cell (node or edge) in the graph. The first cell is
   * defined as the cell with the lowest `zIndex`.
   */
  getFirstCell() {
    return this.collection.first()
  }

  /**
   * Returns the last cell (node or edge) in the graph. The last cell is
   * defined as the cell with the highest `zIndex`.
   */
  getLastCell() {
    return this.collection.last()
  }

  /**
   * Returns the lowest `zIndex` value in the graph.
   */
  getMinZIndex() {
    const first = this.collection.first()
    return first ? first.getZIndex() || 0 : 0
  }

  /**
   * Returns the highest `zIndex` value in the graph.
   */
  getMaxZIndex() {
    const last = this.collection.last()
    return last ? last.getZIndex() || 0 : 0
  }

  protected getCellsFromCache<T extends Cell = Cell>(cache: {
    [key: string]: boolean
  }) {
    return cache
      ? Object.keys(this.edges)
          .map(id => this.getCell<T>(id))
          .filter(cell => cell != null)
      : []
  }

  /**
   * Returns all the nodes in the graph.
   */
  getNodes() {
    return this.getCellsFromCache<Node>(this.nodes)
  }

  /**
   * Returns all the edges in the graph.
   */
  getEdges() {
    return this.getCellsFromCache<Edge>(this.edges)
  }

  /**
   * Returns all outgoing edges for the node.
   */
  getOutgoingEdges(node: Node | string) {
    const nodeId = typeof node === 'string' ? node : node.id
    const cache = this.out && this.out[nodeId]
    return this.getCellsFromCache<Edge>(cache)
  }

  /**
   * Returns all incoming edges for the node.
   */
  getIncomingEdges(node: Node | string) {
    const nodeId = typeof node === 'string' ? node : node.id
    const cache = this.in && this.in[nodeId]
    return this.getCellsFromCache<Edge>(cache)
  }

  /**
   * Returns edges connected with cell.
   */
  getConnectedEdges(
    cell: Cell | string,
    options: Model.GetConnectedEdgesOptions = {},
  ) {
    const result: Edge[] = []
    const node = typeof cell === 'string' ? this.getCell(cell) : cell
    if (node == null) {
      return result
    }

    const cache: { [id: string]: boolean } = {}
    const indirect = options.indirect
    let incoming = options.incoming
    let outgoing = options.outgoing
    if (incoming == null && outgoing == null) {
      incoming = outgoing = true
    }

    const collect = (cell: Cell, isOutgoing: boolean) => {
      const edges = isOutgoing
        ? this.getOutgoingEdges(cell.id)
        : this.getIncomingEdges(cell.id)

      edges.forEach(edge => {
        if (cache[edge.id]) {
          return
        }

        result.push(edge)
        cache[edge.id] = true

        if (indirect) {
          if (incoming) {
            collect(edge, false)
          }

          if (outgoing) {
            collect(edge, true)
          }
        }
      })

      if (indirect && cell.isEdge()) {
        const terminal = isOutgoing
          ? cell.getTargetCell()
          : cell.getSourceCell()
        if (terminal && terminal.isEdge()) {
          if (!cache[terminal.id]) {
            result.push(terminal)
            collect(terminal, isOutgoing)
          }
        }
      }
    }

    if (outgoing) {
      collect(node, true)
    }

    if (incoming) {
      collect(node, false)
    }

    if (options.deep) {
      const descendants = node.getDescendants({ deep: true })
      const embedsCache: KeyValue<boolean> = {}
      descendants.forEach(cell => {
        if (cell.isNode()) {
          embedsCache[cell.id] = true
        }
      })

      const collectSub = (cell: Cell, isOutgoing: boolean) => {
        const edges = isOutgoing
          ? this.getOutgoingEdges(cell.id)
          : this.getIncomingEdges(cell.id)

        edges.forEach(edge => {
          if (!cache[edge.id]) {
            const sourceCell = edge.getSourceCell()
            const targetCell = edge.getTargetCell()

            if (
              !options.enclosed &&
              sourceCell &&
              embedsCache[sourceCell.id] &&
              targetCell &&
              embedsCache[targetCell.id]
            ) {
              return
            }

            result.push(edge)
            cache[edge.id] = true
          }
        })
      }

      descendants.forEach(cell => {
        if (cell.isEdge()) {
          return
        }

        if (outgoing) {
          collectSub(cell, true)
        }

        if (incoming) {
          collectSub(cell, false)
        }
      })
    }

    return result
  }

  protected isBoundary(cell: Cell | string, isOrigin: boolean) {
    const id = typeof cell === 'string' ? cell : cell.id
    const map = isOrigin ? this.in : this.out
    const dic = map[id]
    return dic == null || ObjectExt.isEmpty(dic)
  }

  protected getBoundaryNodes(isOrigin: boolean) {
    const result: Node[] = []
    Object.keys(this.nodes).forEach(nodeId => {
      if (this.isBoundary(nodeId, isOrigin)) {
        const node = this.getCell<Node>(nodeId)
        if (node) {
          result.push(node)
        }
      }
    })
    return result
  }

  /**
   * Returns an array of all the roots of the graph.
   */
  getOrigins() {
    return this.getBoundaryNodes(true)
  }

  /**
   * Returns an array of all the leafs of the graph.
   */
  getLeafs() {
    return this.getBoundaryNodes(false)
  }

  /**
   * Returns `true` if the node is a root node, i.e. there is no edges
   * coming to the node.
   */
  isOrigin(cell: Cell | string) {
    return this.isBoundary(cell, true)
  }

  /**
   * Returns `true` if the node is a leaf node, i.e. there is no edges
   * going out from the node.
   */
  isLeaf(cell: Cell | string) {
    return this.isBoundary(cell, false)
  }

  /**
   * Returns all the neighbors of node in the graph. Neighbors are all
   * the nodes connected to node via either incoming or outgoing edge.
   */
  getNeighbors(cell: Cell, options: Model.GetNeighborsOptions = {}) {
    let incoming = options.incoming
    let outgoing = options.outgoing
    if (incoming == null && outgoing == null) {
      incoming = outgoing = true
    }

    const edges = this.getConnectedEdges(cell, options)
    const map = edges.reduce<KeyValue<Cell>>((memo, edge) => {
      const hasLoop = edge.hasLoop(options)
      const sourceCell = edge.getSourceCell()
      const targetCell = edge.getTargetCell()

      if (
        incoming &&
        sourceCell &&
        sourceCell.isNode() &&
        !memo[sourceCell.id]
      ) {
        if (
          hasLoop ||
          (sourceCell !== cell &&
            (!options.deep || !sourceCell.isDescendantOf(cell)))
        ) {
          memo[sourceCell.id] = sourceCell
        }
      }

      if (
        outgoing &&
        targetCell &&
        targetCell.isNode() &&
        !memo[targetCell.id]
      ) {
        if (
          hasLoop ||
          (targetCell !== cell &&
            (!options.deep || !targetCell.isDescendantOf(cell)))
        ) {
          memo[targetCell.id] = targetCell
        }
      }

      return memo
    }, {})

    if (cell.isEdge()) {
      if (incoming) {
        const sourceCell = cell.getSourceCell()
        if (sourceCell && sourceCell.isNode() && !map[sourceCell.id]) {
          map[sourceCell.id] = sourceCell
        }
      }
      if (outgoing) {
        const targetCell = cell.getTargetCell()
        if (targetCell && targetCell.isNode() && !map[targetCell.id]) {
          map[targetCell.id] = targetCell
        }
      }
    }

    return Object.keys(map).map(id => map[id])
  }

  /**
   * Returns `true` if `cell2` is a neighbor of `cell1`.
   */
  isNeighbor(
    cell1: Cell,
    cell2: Cell,
    options: Model.GetNeighborsOptions = {},
  ) {
    let incoming = options.incoming
    let outgoing = options.outgoing
    if (incoming == null && outgoing == null) {
      incoming = outgoing = true
    }

    return this.getConnectedEdges(cell1, options).some(edge => {
      const sourceCell = edge.getSourceCell()
      const targetCell = edge.getTargetCell()

      if (incoming && sourceCell && sourceCell.id === cell2.id) {
        return true
      }

      if (outgoing && targetCell && targetCell.id === cell2.id) {
        return true
      }
    })
  }

  getSuccessors(cell: Cell, options: Model.GetDescendantsOptions) {
    const descendants: Cell[] = []
    this.search(
      cell,
      curr => {
        if (curr !== cell) {
          descendants.push(curr)
        }
      },
      { ...options, outgoing: true },
    )
    return descendants
  }

  /**
   * Returns `true` if `cell2` is a successor of `cell1`.
   */
  isSuccessor(cell1: Cell, cell2: Cell) {
    let result = false
    this.search(
      cell1,
      curr => {
        if (curr === cell2 && curr !== cell1) {
          result = true
          return false
        }
      },
      { outgoing: true },
    )
    return result
  }

  getPredecessors(cell: Cell, options: Model.GetDescendantsOptions) {
    const ancestors: Cell[] = []
    this.search(
      cell,
      curr => {
        if (curr !== cell) {
          ancestors.push(curr)
        }
      },
      { ...options, incoming: true },
    )
    return ancestors
  }

  /**
   * Returns `true` if `cell2` is a predecessor of `cell1`.
   */
  isPredecessor(cell1: Cell, cell2: Cell) {
    let result = false
    this.search(
      cell1,
      curr => {
        if (curr === cell2 && curr !== cell1) {
          result = true
          return false
        }
      },
      { incoming: true },
    )
    return result
  }

  /**
   * Returns the common ancestor of the passed cells.
   */
  getCommonAncestor(...cells: (Cell | null | undefined)[]) {
    return Cell.getCommonAncestor(...cells)
  }

  /**
   * Returns an array of cells that result from finding nodes/edges that
   * are connected to any of the cells in the cells array. This function
   * loops over cells and if the current cell is a edge, it collects its
   * source/target nodes; if it is an node, it collects its incoming and
   * outgoing edges if both the edge terminal (source/target) are in the
   * cells array.
   */
  getSubgraph(cells: Cell[], options: Model.GetSubgraphOptions = {}) {
    const subgraph: Cell[] = []
    const cache: KeyValue<Cell> = {}
    const nodes: Node[] = []
    const edges: Edge[] = []
    const collect = (cell: Cell) => {
      if (!cache[cell.id]) {
        subgraph.push(cell)
        cache[cell.id] = cell
        if (cell.isEdge()) {
          edges.push(cell)
        }

        if (cell.isNode()) {
          nodes.push(cell)
        }
      }
    }

    cells.forEach(cell => {
      collect(cell)
      if (options.deep) {
        const descendants = cell.getDescendants({ deep: true })
        descendants.forEach(descendant => collect(descendant))
      }
    })

    edges.forEach(edge => {
      // For edges, include their source & target
      const sourceCell = edge.getSourceCell()
      const targetCell = edge.getTargetCell()
      if (sourceCell && !cache[sourceCell.id]) {
        subgraph.push(sourceCell)
        cache[sourceCell.id] = sourceCell
        if (sourceCell.isNode()) {
          nodes.push(sourceCell)
        }
      }
      if (targetCell && !cache[targetCell.id]) {
        subgraph.push(targetCell)
        cache[targetCell.id] = targetCell
        if (targetCell.isNode()) {
          nodes.push(targetCell)
        }
      }
    })

    nodes.forEach(node => {
      // For nodes, include their connected edges if their source/target
      // is in the subgraph.
      const edges = this.getConnectedEdges(node, options)
      edges.forEach(edge => {
        const sourceCell = edge.getSourceCell()
        const targetCell = edge.getTargetCell()
        if (
          !cache[edge.id] &&
          sourceCell &&
          cache[sourceCell.id] &&
          targetCell &&
          cache[targetCell.id]
        ) {
          subgraph.push(edge)
          cache[edge.id] = edge
        }
      })
    })

    return subgraph
  }

  cloneSubgraph(cells: Cell[], options: Model.GetSubgraphOptions = {}) {
    const subgraph = this.getSubgraph(cells, options)
    return this.cloneCells(subgraph)
  }

  cloneCells(cells: Cell[]) {}

  /**
   * Returns an array of nodes whose bounding box contains point.
   * Note that there can be more then one node as nodes might overlap.
   */
  getNodesFromPoint(x: number, y: number): Cell[]
  getNodesFromPoint(p: Point.PointLike): Cell[]
  getNodesFromPoint(x: number | Point.PointLike, y?: number) {
    const p = typeof x === 'number' ? { x, y: y || 0 } : x
    return this.getNodes().filter(node => {
      return node.getBBox().containsPoint(p)
    })
  }

  /**
   * Returns an array of nodes whose bounding box top/left coordinate
   * falls into the rectangle.
   */
  getNodesInArea(
    x: number,
    y: number,
    w: number,
    h: number,
    options?: Model.GetCellsInAreaOptions,
  ): Cell[]
  getNodesInArea(
    rect: Rectangle.RectangleLike,
    options?: Model.GetCellsInAreaOptions,
  ): Cell[]
  getNodesInArea(
    x: number | Rectangle.RectangleLike,
    y?: number | Model.GetCellsInAreaOptions,
    w?: number,
    h?: number,
    options?: Model.GetCellsInAreaOptions,
  ): Cell[] {
    const rect =
      typeof x === 'number'
        ? new Rectangle(x, y as number, w as number, h as number)
        : Rectangle.create(x)
    const opts =
      typeof x === 'number' ? options : (y as Model.GetCellsInAreaOptions)
    const strict = opts && opts.strict
    return this.getNodes().filter(node => {
      const bbox = node.getBBox()
      return strict ? rect.containsRect(bbox) : rect.isIntersectWith(bbox)
    })
  }

  getNodesUnderNode(
    node: Node,
    options: {
      by?: 'bbox' | Rectangle.KeyPoint
    } = {},
  ) {
    const bbox = node.getBBox()
    const nodes =
      options.by == null || options.by === 'bbox'
        ? this.getNodesInArea(bbox)
        : this.getNodesFromPoint(bbox[options.by])

    return nodes.filter(
      curr => node.id !== curr.id && !curr.isDescendantOf(node),
    )
  }

  /**
   * Returns the bounding box that surrounds all cells in the graph.
   */
  getBBox() {
    return this.getCellsBBox(this.getCells())
  }

  /**
   * Returns the bounding box that surrounds all the given cells.
   */
  getCellsBBox(cells: Cell[], options: Cell.GetCellsBBoxOptions = {}) {
    return Cell.getCellsBBox(cells, options)
  }

  // #region search

  search(
    cell: Cell,
    iterator: Model.SearchIterator,
    options: Model.SearchOptions = {},
  ) {
    if (options.breadthFirst) {
      this.breadthFirstSearch(cell, iterator, options)
    } else {
      this.depthFirstSearch(cell, iterator, options)
    }
  }

  breadthFirstSearch(
    cell: Cell,
    iterator: Model.SearchIterator,
    options: Model.GetNeighborsOptions = {},
  ) {
    const queue: Cell[] = []
    const visited: KeyValue<boolean> = {}
    const distance: KeyValue<number> = {}

    queue.push(cell)
    distance[cell.id] = 0

    while (queue.length > 0) {
      const next = queue.shift()
      if (next == null || visited[next.id]) {
        continue
      }
      visited[next.id] = true
      if (iterator.call(this, next, distance[next.id]) === false) {
        continue
      }
      const neighbors = this.getNeighbors(next, options)
      neighbors.forEach(neighbor => {
        distance[neighbor.id] = distance[next.id] + 1
        queue.push(neighbor)
      })
    }
  }

  depthFirstSearch(
    cell: Cell,
    iterator: Model.SearchIterator,
    options: Model.GetNeighborsOptions = {},
  ) {
    const queue: Cell[] = []
    const visited: KeyValue<boolean> = {}
    const distance: KeyValue<number> = {}

    queue.push(cell)
    distance[cell.id] = 0

    while (queue.length > 0) {
      const next = queue.pop()
      if (next == null || visited[next.id]) {
        continue
      }
      visited[next.id] = true
      if (iterator.call(this, next, distance[next.id]) === false) {
        continue
      }
      const neighbors = this.getNeighbors(next, options)
      const lastIndex = queue.length
      neighbors.forEach(neighbor => {
        distance[neighbor.id] = distance[next.id] + 1
        queue.splice(lastIndex, 0, neighbor)
      })
    }
  }

  // #endregion

  // #region transform

  /**
   * Translate all cells in the graph by `tx` and `ty` pixels.
   */
  translate(tx: number, ty: number, options: Cell.TranslateOptions) {
    this.getCells()
      .filter(cell => !cell.hasParent())
      .forEach(cell => cell.translate(tx, ty, options))

    return this
  }

  resize(width: number, height: number, options: Cell.SetOptions) {
    return this.resizeCells(width, height, this.getCells(), options)
  }

  resizeCells(
    width: number,
    height: number,
    cells: Cell[],
    options: Cell.SetOptions = {},
  ) {
    const bbox = this.getCellsBBox(cells)
    if (bbox) {
      const sx = Math.max(width / bbox.width, 0)
      const sy = Math.max(height / bbox.height, 0)
      const origin = bbox.getOrigin()
      cells.forEach(cell => cell.scale(sx, sy, origin, options))
    }

    return this
  }

  // #endregion

  // #region serialize/deserialize

  toJSON() {}

  fromJSON() {}

  // #endregion

  // #region batch

  startBatch(name: string, data: KeyValue = {}) {
    this.batches[name] = (this.batches[name] || 0) + 1
    this.trigger('batch:start', { name, data })
    return this
  }

  stopBatch(name: string, data: KeyValue = {}) {
    this.batches[name] = (this.batches[name] || 0) - 1
    this.trigger('batch:stop', { name, data })
    return this
  }

  executeBatch<T>(name: string, execute: () => T, data: KeyValue = {}) {
    this.startBatch(name, data)
    const result = execute()
    this.stopBatch(name, data)
    return result
  }

  hasActiveBatch(name: string | string[] = Object.keys(this.batches)) {
    const names = Array.isArray(name) ? name : [name]
    return names.some(batch => this.batches[batch] > 0)
  }

  // #endregion
}

export namespace Model {
  export interface GetCellsInAreaOptions {
    strict?: boolean
  }

  export interface SearchOptions extends GetNeighborsOptions {
    breadthFirst?: boolean
  }

  export type SearchIterator = (
    this: Model,
    cell: Cell,
    distance: number,
  ) => any

  export interface GetDescendantsOptions {
    deep?: boolean
    breadthFirst?: boolean
  }

  export interface GetNeighborsOptions {
    deep?: boolean
    incoming?: boolean
    outgoing?: boolean
    indirect?: boolean
  }

  export interface GetConnectedEdgesOptions extends GetNeighborsOptions {
    enclosed?: boolean
  }

  export interface GetSubgraphOptions {
    deep?: boolean
  }
}

export namespace Model {
  export interface EventArgs {
    'batch:start': {
      name: string
      data: KeyValue
    }
    'batch:stop': {
      name: string
      data: KeyValue
    }
    'cell:added': {
      cell: Cell
      options: Collection.AddOptions
    }
    'cell:removed': {
      cell: Cell
      options: Collection.RemoveOptions
    }
    'cell:changed': {
      cell: Cell
      options: Cell.MutateOptions
    }
    sort?: null
    reset: {
      current: Cell[]
      previous: Cell[]
      options: Collection.SetOptions
    }
    change: {
      added: Cell[]
      merged: Cell[]
      removed: Cell[]
      options: Collection.SetOptions
    }
  }
}
