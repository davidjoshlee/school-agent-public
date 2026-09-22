import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { hasErrorCode } from "../util/errors.js"

const execute = promisify(execFile)

export class VaultGitError extends Error {
  readonly name = "VaultGitError"

  constructor(
    readonly root: string,
    readonly detail: string,
  ) {
    super(`Local vault git failed at ${root}: ${detail}`)
  }
}

export class LocalVaultGit {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async initialize(): Promise<void> {
    if (await pathExists(join(this.#root, ".git"))) {
      return
    }
    await this.run(["init"])
    await this.run(["config", "user.name", "school-agent"])
    await this.run(["config", "user.email", "school-agent@local"])
  }

  async commit(message: string): Promise<void> {
    await this.run(["add", "--all"])
    if (await this.hasStagedChanges()) {
      await this.run(["commit", "-m", `school-agent: ${message}`])
    }
  }

  private async hasStagedChanges(): Promise<boolean> {
    try {
      await execute("git", ["diff", "--cached", "--quiet"], { cwd: this.#root })
      return false
    } catch (error: unknown) {
      if (hasErrorCode(error, 1)) {
        return true
      }
      throw this.error(error)
    }
  }

  private async run(arguments_: readonly string[]): Promise<void> {
    try {
      await execute("git", arguments_, { cwd: this.#root })
    } catch (error: unknown) {
      throw this.error(error)
    }
  }

  private error(error: unknown): VaultGitError {
    return new VaultGitError(this.#root, error instanceof Error ? error.message : String(error))
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}
