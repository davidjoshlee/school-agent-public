import { expect, it } from "vitest"

import packageMetadata from "../package.json"
import { getPackageVersion } from "../src/version.js"

it("reads the CLI version from the package metadata", () => {
  expect(getPackageVersion()).toBe(packageMetadata.version)
})
