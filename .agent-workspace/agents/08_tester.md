# Test Results

_Generated: 2026-05-28T16:09:25.643Z_

{
  "passed": false,
  "testsRun": 0,
  "errors": [
    "src/extension.ts(17,41): error TS2552: Cannot find name 'panelProvider'. Did you mean 'PanelProvider'?",
    "src/extension.ts(18,29): error TS2552: Cannot find name 'panelProvider'. Did you mean 'PanelProvider'?",
    "src/models/generatedApp.model.ts(27,10): error TS2304: Cannot find name 'FileModel'.",
    "src/services/codeGenerationService.ts(87,9): error TS2353: Object literal may only specify known properties, and 'path' does not exist in type 'FileModel'"
  ],
  "warnings": [],
  "needsFix": true,
  "fixDescription": "The errors indicate that the types 'panelProvider' and 'FileModel' are not recognized. Ensure that these types are correctly defined or imported. The error in 'codeGenerationService.ts' suggests a typo or missing property in an object literal.",
  "rawOutput": "src/extension.ts(17,41): error TS2552: Cannot find name 'panelProvider'. Did you mean 'PanelProvider'?\nsrc/extension.ts(18,29): error TS2552: Cannot find name 'panelProvider'. Did you mean 'PanelProvider'?\nsrc/models/generatedApp.model.ts(27,10): error TS2304: Cannot find name 'FileModel'.\nsrc/services/codeGenerationService.ts(87,9): error TS2353: Object literal may only specify known properties, and 'path' does not exist in type 'FileModel'"
}
