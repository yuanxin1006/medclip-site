# MedClip Video AI V2.2B repair policy

V2.2B is a single-round, deterministic repair boundary around the frozen V2.2A evaluator and V2.0D executor. It does not perform Provider calls, network candidate search, recursive replanning, or direct project mutation.

## Eligible repairs

- `INTENDED_STATE_NOT_REALIZED`: reapply the asset in the trusted, human-reviewed initial plan.
- `LOW_SEMANTIC_SUPPORT`: when the entry is not human-protected, choose an original V2.0A candidate whose semantic metric improves, whose matching thresholds pass, whose source range is supported, and whose asset still exists.
- bounded repetition defects: choose an original threshold-clearing V2.0A candidate only when the existing local repetition pattern is reduced.

Narrative warnings remain report-only unless trusted evidence can prove a bounded improvement. The V2.2B implementation intentionally makes no such speculative repair. Rhythm warnings are also report-only: the existing canonical surface cannot move an arbitrary cut without source-range and future-child ambiguity. `NOT_EVALUABLE`, missing targets/media, structural corruption, unknown IDs, and operations requiring new canonical actions are unsupported.

An original `USER_REJECTED` entry cannot be resurrected. A defect marked `HUMAN_DECISION_PROTECTED` cannot emit an automatic mutation. Repair `MODIFY` is limited to safe candidates from the same original V2.0A ranked set.

## Bounds and ordering

- `MAX_REPAIR_ROUNDS = 1`.
- `MAX_REPAIR_ACTIONS = 6`; a larger required batch fails closed rather than truncating.
- One target receives at most one mutation. Conflicts resolve by severity, then metric priority (`REQUIREMENT_COMPLETION`, `SEMANTIC_MATCH`, `REPETITION`), then stable interval/defect identity.
- Candidate ordering uses the existing component metrics and stable asset-ID tie-breaking. It introduces no aggregate quality score.
- Attempt fingerprints include the source evaluation, source project fingerprint, defect IDs, and target/action/value tuples. A repeated tuple is rejected.

## Re-evaluation and comparison

After a successful reviewed V2.0D batch, the existing V2.2A evaluator is called exactly once against the repaired project and the final human-approved repair intent. The evaluator receives repaired targets plus only the preceding context required to evaluate a bounded repetition defect.

Each targeted defect is compared on its own typed metric:

- absence of the same metric defect for the target means `RESOLVED`;
- semantic support improves only when the deterministic semantic score increases;
- repetition improves only when the number of bounded repetition defects on the target decreases;
- a requirement defect must disappear to resolve.

The repaired state is retained only when every approved target resolves or improves, no structural failure exists, no protected-state regression exists, and every human-approved final repair asset is present on its target. A safe improvement that still carries a warning becomes `REPAIR_FINAL_UNRESOLVED_IMPROVED`. A fully resolved set becomes `REPAIR_FINAL_PASS`.

If any keep condition fails, the exact pre-repair snapshot remains authoritative and the result is `REPAIR_ROLLED_BACK`. A rolled-back, rejected, or failed repair creates no history entry. A retained repair exposes exactly one existing-project snapshot boundary so Undo restores the pre-repair state and Redo restores the accepted repaired state.
