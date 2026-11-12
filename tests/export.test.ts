import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeCsvRows } from "../lib/export";

test("CSV serialization quotes only fields that need it and preserves numeric values", () => {
  const csv = serializeCsvRows([
    { Rank: 1, Competitor: "Graham Lo", Score: 36, Deduction: -0.3 },
    { Rank: 2, Competitor: "Lo, Graham", Score: 95.17, Deduction: null },
  ]);

  assert.equal(csv, [
    "Rank,Competitor,Score,Deduction",
    "1,Graham Lo,36,-0.3",
    '2,"Lo, Graham",95.17,Pending',
  ].join("\r\n"));
});

test("CSV serialization protects formula-like text without quoting ordinary fields", () => {
  assert.equal(
    serializeCsvRows([{ Competitor: "=SUM(A1:A2)", Status: "Complete" }]),
    "Competitor,Status\r\n'=SUM(A1:A2),Complete",
  );
});
