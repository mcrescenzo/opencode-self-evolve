import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [targetPath, sourcePath] = process.argv.slice(2);
const temporaryPath = path.join(
  path.dirname(targetPath),
  `.${path.basename(targetPath)}.${process.pid}.0123456789abcdef.tmp`,
);
const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeFileSync(descriptor, readFileSync(sourcePath));
fsyncSync(descriptor);
closeSync(descriptor);
linkSync(temporaryPath, targetPath);
process.exit(86);
