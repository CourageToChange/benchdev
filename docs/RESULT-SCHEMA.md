# BenchDev result schema

Schema version `1` uses the fields below. Every measured number is stored beside its unit. Version
identifiers are positive integers. Month values are deliberately coarse and use `YYYY-MM`.

## `RunResult`

| Field | Required in | Unit |
|---|---|---|
| `kind` | all results | discriminator: `scored` or `invalid` |
| `schemaVersion` | all results | result schema version identifier |
| `protocolVersion` | all results | benchmark protocol version identifier |
| `baselineVersion` | all results | baseline version identifier |
| `previewMode` | all results | enum: `standard` or `reduced-motion` |
| `score.value` | scored | BenchDev points |
| `score.unit` | scored | unit label for `score.value` |
| `subScores` | scored | array of present sub-scores |
| `subScores[].id` | scored | stable sub-score identifier |
| `subScores[].value` | scored | quantity named by `subScores[].unit` |
| `subScores[].unit` | scored | unit label for `subScores[].value` |
| `measurements` | scored | array of raw measurements used to show the working |
| `measurements[].id` | scored | stable measurement identifier |
| `measurements[].value` | scored | quantity named by `measurements[].unit` |
| `measurements[].unit` | scored | unit label for `measurements[].value` |
| `reasons` | invalid | array of invalidation reason codes |
| `reasons[]` | invalid | stable reason code, no numeric unit |

An invalid result has no `score`, `subScores`, or `measurements` field. A scored result has no
`reasons` field.

## Baseline set

| Field | Required in | Unit |
|---|---|---|
| `baselineVersion` | baseline set | baseline version identifier |
| `entries` | baseline set | array of frozen reference entries |
| `entries[].id` | baseline entry | stable reference identifier |
| `entries[].protocolVersion` | baseline entry | benchmark protocol version identifier |
| `entries[].referenceDevice` | baseline entry | named reference identity object |
| `entries[].referenceDevice.model` | baseline entry | device model text |
| `entries[].referenceDevice.osName` | baseline entry | operating system name text |
| `entries[].referenceDevice.osVersion` | baseline entry | operating system version text |
| `entries[].referenceDevice.browserName` | baseline entry | browser name text |
| `entries[].referenceDevice.browserVersion` | baseline entry | browser version text |
| `entries[].referenceDevice.measuredMonth` | baseline entry | calendar month, `YYYY-MM` |
| `entries[].referenceDevice.note` | baseline entry | provenance note text |
| `entries[].measurements` | baseline entry | keyed raw measurement object |
| `entries[].measurements.<id>.value` | baseline entry | quantity named by the sibling `unit`, or `null` while unmeasured |
| `entries[].measurements.<id>.unit` | baseline entry | unit label for the sibling `value` |
| `entries[].measurements.<id>.provenance.deviceModel` | baseline measurement | device model text |
| `entries[].measurements.<id>.provenance.osName` | baseline measurement | operating system name text |
| `entries[].measurements.<id>.provenance.osVersion` | baseline measurement | operating system version text |
| `entries[].measurements.<id>.provenance.browserName` | baseline measurement | browser name text |
| `entries[].measurements.<id>.provenance.browserVersion` | baseline measurement | browser version text |
| `entries[].measurements.<id>.provenance.measuredMonth` | baseline measurement | calendar month, `YYYY-MM` |
| `entries[].measurements.<id>.provenance.runCount` | baseline measurement | runs |
| `entries[].measurements.<id>.provenance.aggregationMethod` | baseline measurement | method name text |
| `entries[].measurements.<id>.provenance.source` | baseline measurement | source reference text |
| `entries[].measurements.<id>.provenance.note` | baseline measurement | provenance note text |

All four measurements in the current baseline are filled in, so none of them is `null`.

## Corpus envelope and record

| Field | Required in | Unit |
|---|---|---|
| `schemaVersion` | corpus envelope | corpus schema version identifier |
| `corpusVersion` | corpus envelope | corpus data version identifier |
| `buildMonth` | corpus envelope | calendar month, `YYYY-MM` |
| `entries` | corpus envelope | array of corpus records |
| `entries[].kind` | corpus record | discriminator: `scored` or `invalid` |
| `entries[].schemaVersion` | corpus record | result schema version identifier |
| `entries[].protocolVersion` | corpus record | benchmark protocol version identifier |
| `entries[].baselineVersion` | corpus record | baseline version identifier |
| `entries[].scoringVersion` | scored corpus record | scoring version identifier |
| `entries[].previewMode` | corpus record | preview mode text |
| `entries[].capturedMonth` | corpus record | calendar month, `YYYY-MM` |
| `entries[].detected` | corpus record | machine-detected identity object |
| `entries[].detected.browser.name` | corpus record | browser name text |
| `entries[].detected.browser.majorVersion` | corpus record | browser major version identifier |
| `entries[].detected.osFamily` | corpus record | operating system family text |
| `entries[].detected.reportedConcurrency.value` | corpus record | logical processors, or `null` when unavailable |
| `entries[].detected.reportedConcurrency.unit` | corpus record | unit label for reported concurrency |
| `entries[].detected.measuredParallelism.value` | corpus record | workers, or `null` when unavailable |
| `entries[].detected.measuredParallelism.unit` | corpus record | unit label for measured parallelism |
| `entries[].detected.gpuRenderer` | corpus record | renderer text, or `null` when unavailable |
| `entries[].detected.devicePixelRatio.value` | corpus record | device pixels per CSS pixel |
| `entries[].detected.devicePixelRatio.unit` | corpus record | ratio unit label |
| `entries[].label` | labelled corpus record | optional human claim object |
| `entries[].label.value` | labelled corpus record | human-supplied device label text |
| `entries[].label.claimed` | labelled corpus record | literal `true`, marking the label as claimed |
| `entries[].score.value` | scored corpus record | BenchDev points |
| `entries[].score.unit` | scored corpus record | unit label for the score |
| `entries[].subScores` | scored corpus record | array of present sub-scores |
| `entries[].subScores[].id` | scored corpus record | stable sub-score identifier |
| `entries[].subScores[].value` | scored corpus record | quantity named by the sibling `unit` |
| `entries[].subScores[].unit` | scored corpus record | unit label for the sibling `value` |
| `entries[].reasons` | invalid corpus record | array of invalidation reason codes |
| `entries[].reasons[]` | invalid corpus record | stable reason code, no numeric unit |

`detected` is always present and contains only machine-observed facts. `label` is optional and, when
present, is structurally marked as claimed. The reader validates `schemaVersion` before accepting a
record and returns only records whose `protocolVersion` exactly matches the requested protocol and,
for scored records, whose `scoringVersion` matches the scoring in use.
