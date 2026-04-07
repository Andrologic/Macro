const { parseUnifiedDiff } = require('./services/gitDiffParser.ts');

const patch = `diff --git a/test b/test
--- a/test
+++ b/test
@@ -1,3 +1,3 @@
   const a = 1;
-  const b = 2;
+  const b = 3;
`;

const result = parseUnifiedDiff(patch);
console.log("Original:", JSON.stringify(result.originalContent));
console.log("Modified:", JSON.stringify(result.modifiedContent));
