/** True when `error` is a Node error carrying the given `code` (e.g. "ENOENT"). */
export function hasErrorCode(error: unknown, code: string | number): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

/** True when `error` is a missing-file/directory error. */
export function isEnoent(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT")
}
