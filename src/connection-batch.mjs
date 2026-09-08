/** 每批最多四个连接任务并行；结果保持选择顺序，避免完成顺序改变最后激活的窗口。 */
export async function connectBatch (items, connect) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await connect(items[index])
    }
  }))
  return results
}
