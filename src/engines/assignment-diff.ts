type Edit = { readonly kind: "added" | "removed" | "unchanged"; readonly line: string }

export function lineDiff(before: string, after: string): string {
  const left = before.split("\n")
  const right = after.split("\n")
  const table = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  )
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const nextRow = table[leftIndex + 1]
      const row = table[leftIndex]
      if (nextRow === undefined || row === undefined) {
        throw new AssignmentDiffError("diff table is incomplete")
      }
      row[rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? (nextRow[rightIndex + 1] ?? 0) + 1
          : Math.max(nextRow[rightIndex] ?? 0, row[rightIndex + 1] ?? 0)
    }
  }
  return renderEdits(backtrack(left, right, table))
}

export class AssignmentDiffError extends Error {
  readonly name = "AssignmentDiffError"
}

function backtrack(
  left: readonly string[],
  right: readonly string[],
  table: readonly number[][],
): Edit[] {
  const edits: Edit[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      edits.push({ kind: "unchanged", line: left[leftIndex] ?? "" })
      leftIndex += 1
      rightIndex += 1
      continue
    }
    const down = table[leftIndex + 1]?.[rightIndex] ?? 0
    const across = table[leftIndex]?.[rightIndex + 1] ?? 0
    if (rightIndex < right.length && (leftIndex === left.length || across >= down)) {
      edits.push({ kind: "added", line: right[rightIndex] ?? "" })
      rightIndex += 1
      continue
    }
    edits.push({ kind: "removed", line: left[leftIndex] ?? "" })
    leftIndex += 1
  }
  return edits
}

function renderEdits(edits: readonly Edit[]): string {
  const rendered = edits
    .filter((edit) => edit.kind !== "unchanged")
    .map((edit) => `${edit.kind === "added" ? "+" : "-"}${edit.line}`)
  return rendered.length === 0 ? "(no user edits)" : rendered.join("\n")
}
