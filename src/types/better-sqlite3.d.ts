declare module "better-sqlite3" {
  type SqliteValue = string | number | bigint | Buffer | null

  interface Statement {
    readonly get: (...parameters: readonly SqliteValue[]) => unknown
    readonly all: (...parameters: readonly SqliteValue[]) => readonly unknown[]
    readonly run: (...parameters: readonly SqliteValue[]) => RunResult
  }

  interface RunResult {
    readonly changes: number
  }

  class Database {
    constructor(path: string)
    readonly exec: (sql: string) => void
    readonly pragma: (source: string) => unknown
    readonly prepare: (sql: string) => Statement
    readonly transaction: <T extends (...arguments_: readonly never[]) => unknown>(action: T) => T
    readonly close: () => void
  }

  export = Database
}
