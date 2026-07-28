import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

export default async function notarizeDesktop(context) {
  const profile = process.env.KESTREL_DESKTOP_NOTARY_PROFILE?.trim();
  if (!profile) {
    throw new Error(
      "KESTREL_DESKTOP_NOTARY_PROFILE is required for a Desktop release build.",
    );
  }
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const submissionPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.notary.zip`,
  );
  rmSync(submissionPath, { force: true });
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, submissionPath],
    { stdio: "inherit" },
  );
  try {
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        submissionPath,
        "--keychain-profile",
        profile,
        "--wait",
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(submissionPath, { force: true });
  }
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
  execFileSync(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
}
