// 服务层 FIFO：一切存储写入的复合操作（create/edit/delete、run 开始/结算、级联、裁剪）
// 整体作为队列的一个槽位入队，槽内「枚举 → 判断 → 多次 Domain 调用」不与其他操作交错；
// 单槽失败只 reject 该槽的调用方，不毒化后续槽（契约 docs/temp/08-storage.md「写入」）。
const noop = () => {}

export class ServiceQueue {
  #tail = Promise.resolve()
  #closed = false

  /** 入队一个槽位；返回该槽自身的 settlement（失败只影响本槽）。关闭后拒绝新槽。 */
  enqueue(job) {
    if (this.#closed) {
      return Promise.reject(new Error('service queue is closed'))
    }
    const result = this.#tail.then(job)
    // 链尾吞掉前序失败：后续槽不受影响
    this.#tail = result.then(noop, noop)
    return result
  }

  /** 等待所有已入队槽位排干。 */
  drain() {
    return this.#tail
  }

  /** 停止接受新槽并排干已入队槽位（「先停生产者 → 排干 → domain.close()」的中间步）。 */
  close() {
    this.#closed = true
    return this.drain()
  }
}
