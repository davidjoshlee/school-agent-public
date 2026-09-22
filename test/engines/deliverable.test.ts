import { describe, expect, it } from "vitest"

import { type DeliverableSource, detectDeliverable } from "../../src/engines/deliverable.js"

// All fixtures are SYNTHETIC — invented companies/topics, not real coursework
// — but they mimic the two real PDF-extraction shapes this module exists
// for: everything collapsed onto one line, with dropped-cap title artifacts
// (a run of 2+ spaces splitting a standalone capital from the rest of its
// word, e.g. "S   TUDY   G   UIDE").

// Shape A: a discussion study guide. One line, dropped-cap title, five
// inline-enumerated questions after a "Prepare your answers..." cue.
const studyGuide = [
  "S   TUDY   G   UIDE:   Market Structures and Pricing Power.",
  "This week we examine how firms in different market structures set prices and respond to rivals.",
  "Read the Northwind Airlines case.",
  "Prepare your answers to the following questions for class discussion:",
  "1. What market structure best describes the airline industry in the case, and why?",
  "2. How does Northwind's pricing strategy change when a low-cost rival enters a route?",
  "3. What are the risks of the price-matching policy described in the case?",
  "4. How would you expect competitors to respond if Northwind cut fares by 15 percent?",
  "5. What recommendation would you give Northwind's pricing team for the next quarter?",
].join(" ")

// Shape B: a case with input facts (transactions 1-8, NOT a deliverable)
// followed by a part-scoped Required section. One line.
const transactionCase =
  "Meridian Robotics Inc. Transaction Analysis. During 2022, Meridian Robotics engaged in the following activities: " +
  "1. On January 1, 2022, the company issued 8 million shares of common stock for cash. " +
  "2. On April 1, 2022, Meridian signed a two-year lease for warehouse space. " +
  "3. On July 1, 2022, the company purchased equipment for 2 million dollars cash. " +
  "4. On October 1, 2022, Meridian issued a 5 million dollar, five-year bond at par. " +
  "5. On November 15, 2022, the company declared and paid a cash dividend. " +
  "6. On December 1, 2022, Meridian received a 1 million dollar customer deposit for a future order. " +
  "In the process of preparing the trial balance, the following additional information was gathered: " +
  "7. The 24-month lease requires straight-line rent expense recognition. " +
  "8. At the end of 2022, Meridian accrued four months of interest on the bond. " +
  "Required: [For your convenience, use the attached template.] " +
  "PART I (due Thursday, September 25): Analyze and record Meridian's transactions for fiscal year 2022 using T-accounts, " +
  "showing the effect of each transaction on the relevant accounts. " +
  "PART II (due Monday, September 29): (a) Prepare Meridian's financial statements: " +
  "- Balance Sheet as of December 31, 2022 - Income Statement for the year ended December 31, 2022 " +
  "(b) Prepare a one-paragraph note disclosing the customer deposit liability."

// A plain reading document: incidental numbers, no directive cue at all.
const readingNote =
  "Reading note: Chapter 7 covers oligopoly pricing models. There are 3 core models covered: " +
  "1. Cournot 2. Bertrand 3. Stackelberg. Read pages 120-145 before class."

// Real-data blemishes found by the eval/real/deliverable-eval.mts local
// eval: (1) a leading "(due ...)" parenthetical bleeding into PART I's
// item, and (2) trailing next-page header/footer furniture bleeding into
// PART II's last item. Both text-hygiene concerns, reproduced synthetically
// here so they're guarded in CI.
const hygieneCase =
  "Atlas Robotics Inc. Transaction Analysis. During 2023, Atlas Robotics engaged in the following activities: " +
  "1. On January 1, 2023, the company issued 10 million shares of common stock for cash. " +
  "2. On March 1, 2023, Atlas signed a three-year lease for office space. " +
  "Required: " +
  "PART I (due Friday, October 3): Analyze and record Atlas's transactions for fiscal year 2023 using T-accounts. " +
  "PART II (due Tuesday, October 7): (a) Prepare Atlas's financial statements: " +
  "- Balance Sheet as of December 31, 2023 - Income Statement for the year ended December 31, 2023 " +
  "(b) What can you conclude about the company's performance in 2023? " +
  "2 ATLAS ROBOTICS INC. TRANSACTION ANALYSIS Additional exhibits follow on the next page."

const source = (path: string, text: string): DeliverableSource => ({ path, text })

describe("detectDeliverable — shape A: discussion study guide", () => {
  it("extracts 5 questions with correct ids, full text, and kind", () => {
    const result = detectDeliverable([source("guidance/study-guide.md", studyGuide)])
    expect(result.kind).toBe("questions")
    if (result.kind !== "questions") throw new Error("expected questions")
    expect(result.items.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5"])
    expect(result.items[0]?.text).toBe(
      "What market structure best describes the airline industry in the case, and why?",
    )
    expect(result.items[4]?.text).toBe(
      "What recommendation would you give Northwind's pricing team for the next quarter?",
    )
    expect(result.sourcePath).toBe("guidance/study-guide.md")
    expect(result.cue).toBe("Prepare your answers to the following questions")
  })
})

describe("detectDeliverable — shape B: case with Required section", () => {
  it("false-positive guard: only Required items are returned, never the transaction facts", () => {
    const result = detectDeliverable([source("assignments/meridian.md", transactionCase)])
    expect(result.kind).toBe("requirements")
    if (result.kind !== "requirements") throw new Error("expected requirements")
    const allText = result.items.map((item) => item.text).join(" ")
    expect(allText).not.toMatch(/issued 8 million shares/)
    expect(allText).not.toMatch(/warehouse space/)
    expect(allText).not.toMatch(/straight-line rent/)
    expect(allText).not.toMatch(/accrued four months/)
  })

  it("scope PART I returns only PART I's single requirement", () => {
    const result = detectDeliverable([source("assignments/meridian.md", transactionCase)], "PART I")
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe("PART I")
    expect(result.items[0]?.text).toMatch(/Analyze and record Meridian's transactions/)
    expect(result.items[0]?.text).not.toMatch(/Balance Sheet/)
  })

  it("scope PART II returns only PART II's lettered items", () => {
    const result = detectDeliverable(
      [source("assignments/meridian.md", transactionCase)],
      "PART II",
    )
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.items.map((item) => item.id)).toEqual(["a", "b"])
    expect(result.items[0]?.text).toMatch(/Balance Sheet/)
    expect(result.items[0]?.text).toMatch(/Income Statement/)
    expect(result.items[1]?.text).toMatch(/customer deposit liability/)
    expect(result.items[0]?.text).not.toMatch(/Analyze and record/)
  })

  it("no scope returns both parts, part-prefixed ids", () => {
    const result = detectDeliverable([source("assignments/meridian.md", transactionCase)])
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.items.map((item) => item.id)).toEqual(["PART I", "PART II.a", "PART II.b"])
  })
})

describe("detectDeliverable — item text hygiene", () => {
  it("strips a leading (due ...) parenthetical from a part's item", () => {
    const result = detectDeliverable([source("assignments/atlas.md", hygieneCase)], "PART I")
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.text).toBe(
      "Analyze and record Atlas's transactions for fiscal year 2023 using T-accounts.",
    )
    expect(result.items[0]?.text).not.toMatch(/^\(/)
    expect(result.items[0]?.text).not.toMatch(/due/i)
  })

  it("trims trailing next-page header/footer furniture from the last item", () => {
    const result = detectDeliverable([source("assignments/atlas.md", hygieneCase)], "PART II")
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.items).toHaveLength(2)
    expect(result.items[1]?.text).toBe(
      "What can you conclude about the company's performance in 2023?",
    )
    expect(result.items[1]?.text).not.toMatch(/ATLAS ROBOTICS INC\. TRANSACTION ANALYSIS/)
    expect(result.items[1]?.text).not.toMatch(/exhibits follow/)
  })
})

describe("detectDeliverable — no cue", () => {
  it("a plain reading document with incidental numbers yields none", () => {
    const result = detectDeliverable([source("readings/ch7.md", readingNote)])
    expect(result).toEqual({ kind: "none" })
  })

  it("robustness: empty sources, whitespace-only text, never throws", () => {
    expect(detectDeliverable([])).toEqual({ kind: "none" })
    expect(() => detectDeliverable([source("empty.md", "")])).not.toThrow()
    expect(detectDeliverable([source("empty.md", "")])).toEqual({ kind: "none" })
    expect(detectDeliverable([source("blank.md", "   \n\t  ")])).toEqual({ kind: "none" })
  })
})

describe("detectDeliverable — inline vs line-based enumeration", () => {
  const items = [
    "Compute the payback period for the proposed plant expansion.",
    "Compute the internal rate of return for the proposed plant expansion.",
    "Recommend whether the company should proceed, with justification.",
  ]

  it("detects the same list collapsed onto one line and split across lines", () => {
    const inline = `Prepare the following: - ${items.join(" - ")}`
    const lined = `Prepare the following:\n- ${items.join("\n- ")}`

    const inlineResult = detectDeliverable([source("a.md", inline)])
    const linedResult = detectDeliverable([source("b.md", lined)])

    if (inlineResult.kind !== "requirements" || linedResult.kind !== "requirements") {
      throw new Error("expected requirements from both forms")
    }
    expect(inlineResult.items.map((item) => item.text)).toEqual(items)
    expect(linedResult.items.map((item) => item.text)).toEqual(items)
  })
})

describe("detectDeliverable — source priority", () => {
  it("a stronger cue wins even from a lower-priority (later) source", () => {
    const weak = source("a.md", "Answer the following questions: 1. What is X? 2. What is Y?")
    const strong = source("c.md", "Required: 1. Compute X. 2. Compute Y.")
    const noCue = source("b.md", readingNote)
    const result = detectDeliverable([noCue, weak, strong])
    expect(result.kind).toBe("requirements")
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.sourcePath).toBe("c.md")
  })

  it("on equal cue strength, the earlier source in priority order wins", () => {
    const first = source("first.md", "Required: 1. Do task Alpha.")
    const second = source("second.md", "Required: 1. Do task Beta.")
    const result = detectDeliverable([first, second])
    if (result.kind !== "requirements") throw new Error("expected requirements")
    expect(result.sourcePath).toBe("first.md")
    expect(result.items[0]?.text).toBe("Do task Alpha.")
  })
})

describe("detectDeliverable — precision/recall over the fixture corpus", () => {
  // A visible regression signal: expected item counts across every fixture
  // above, compared against what the detector actually returns. A
  // heuristic regression shows up here as a number, not just a single
  // failing assertion.
  it("scores 100% precision and recall across the corpus", () => {
    const cases: ReadonlyArray<{
      readonly sources: readonly DeliverableSource[]
      readonly scope?: string
      readonly expected: number
    }> = [
      { sources: [source("s.md", studyGuide)], expected: 5 },
      { sources: [source("t.md", transactionCase)], expected: 3 },
      { sources: [source("t.md", transactionCase)], scope: "PART I", expected: 1 },
      { sources: [source("t.md", transactionCase)], scope: "PART II", expected: 2 },
      { sources: [source("h.md", hygieneCase)], scope: "PART I", expected: 1 },
      { sources: [source("h.md", hygieneCase)], scope: "PART II", expected: 2 },
      { sources: [source("r.md", readingNote)], expected: 0 },
      { sources: [source("empty.md", "")], expected: 0 },
    ]

    let expectedTotal = 0
    let detectedTotal = 0
    let correctTotal = 0
    for (const testCase of cases) {
      const result = detectDeliverable(testCase.sources, testCase.scope)
      const detected = result.kind === "none" ? 0 : result.items.length
      expectedTotal += testCase.expected
      detectedTotal += detected
      correctTotal +=
        detected === testCase.expected ? testCase.expected : Math.min(detected, testCase.expected)
    }

    const precision = detectedTotal === 0 ? 1 : correctTotal / detectedTotal
    const recall = expectedTotal === 0 ? 1 : correctTotal / expectedTotal
    expect(precision).toBe(1)
    expect(recall).toBe(1)
  })
})
