import { expect, test } from "bun:test"
import { windowsToolReadRoots } from "../../src/engines/codesplash/sandbox/windows.ts"

test("Windows runtime grants cover supported tools without the whole Program Files tree", () => {
  expect(windowsToolReadRoots("C:\\Program Files")).toEqual([
    "C:\\Program Files\\Git",
    "C:\\Program Files\\PowerShell",
    "C:\\Program Files\\nodejs",
  ])
  expect(windowsToolReadRoots("D:\\Applications")).not.toContain("D:\\Applications")
})
