import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { resolveSyncSelection } from "../src/canvas/resolve-sync-selection.js"
import { server } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"

describe("resolveSyncSelection", () => {
  it("returns the requested id with no override when discovery surfaces the course", async () => {
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([{ id: "1", name: "Pricing", course_code: "FIN-101" }]),
      ),
    )
    const selection = await resolveSyncSelection(client(), "1")
    expect(selection.courseIds).toEqual(["1"])
    expect(selection.courseOverrides).toBeUndefined()
  })

  it("probes an ended numeric id discovery does not surface and supplies it as an override", async () => {
    server.use(
      http.get("https://canvas.test/api/v1/courses", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220525", () =>
        HttpResponse.json({
          id: "220525",
          name: "Strategy Beyond Markets",
          course_code: "POLECON-231",
        }),
      ),
    )
    const selection = await resolveSyncSelection(client(), "220525", "888888")
    expect(selection.courseIds).toEqual(["220525"])
    expect(selection.courseOverrides).toEqual({
      "220525": { id: "220525", name: "Strategy Beyond Markets", course_code: "POLECON-231" },
    })
  })

  it("falls back to the pilot id only for a non-numeric code discovery cannot resolve", async () => {
    server.use(
      http.get("https://canvas.test/api/v1/courses", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/777", () =>
        HttpResponse.json({ id: "777", name: "Pilot", course_code: "W26-XYZ-1" }),
      ),
    )
    const selection = await resolveSyncSelection(client(), "W26-XYZ-1", "777")
    expect(selection.courseIds).toEqual(["777"])
    expect(selection.courseOverrides).toEqual({
      "777": { id: "777", name: "Pilot", course_code: "W26-XYZ-1" },
    })
  })
})
