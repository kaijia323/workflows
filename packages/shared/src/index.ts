/**
 * DAG 图节点
 */
export interface DagNode {
  id: string
  label: string
  description?: string
}

/**
 * DAG 图边
 */
export interface DagEdge {
  source: string
  target: string
}

/**
 * DAG 图数据
 */
export interface DagGraph {
  nodes: DagNode[]
  edges: DagEdge[]
}

/**
 * 统一 API 响应结构
 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}
