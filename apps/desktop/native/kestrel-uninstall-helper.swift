import Foundation

struct HelperFailure: Error, CustomStringConvertible {
  let message: String
  var description: String { message }
}

struct RemovalFailure: Encodable {
  let targetId: String?
  let code: String
  let message: String
}

struct RemovalReport: Encodable {
  let version: String
  let executor: String
  let planId: String
  let status: String
  let completedAt: String
  let removedTargets: [String]
  let failures: [RemovalFailure]
  let reportPath: String
}

let arguments = CommandLine.arguments
let planPath = value(after: "--plan", in: arguments)
let parentPidText = value(after: "--parent-pid", in: arguments)
let reportPath = value(after: "--report", in: arguments)

var removed: [String] = []
var failures: [RemovalFailure] = []
var resolvedPlanId = ""

do {
  guard let planPath else {
    throw HelperFailure(message: "missing --plan")
  }
  defer {
    try? FileManager.default.removeItem(atPath: planPath)
    _ = rmdir(
      URL(fileURLWithPath: planPath).deletingLastPathComponent().path
    )
  }
  try requireMode0600(planPath)
  let plan = try readPlan(planPath)
  resolvedPlanId = plan["planId"] as? String ?? ""
  guard !resolvedPlanId.isEmpty else {
    throw HelperFailure(message: "plan id is missing")
  }
  guard plan["initiator"] as? String == "desktop" else {
    throw HelperFailure(message: "plan initiator must be desktop")
  }
  if let parentPidText, let parentPid = Int32(parentPidText), parentPid > 0 {
    waitForParentExit(parentPid)
  }
  let targets = try validatedTargets(plan)
  for target in targets {
    guard target.selected else { continue }
    do {
      switch target.kind {
      case "desktop_bundle":
        try removeDesktopBundle(target.path)
        removed.append(target.id)
      case "state_root", "electron_profile", "preferences", "cache", "saved_state":
        try removeDesktopProfilePath(target.path)
        removed.append(target.id)
      default:
        throw HelperFailure(message: "unsupported helper target kind \(target.kind)")
      }
    } catch {
      failures.append(RemovalFailure(
        targetId: target.id,
        code: "DESKTOP_UNINSTALL_HELPER_TARGET_FAILED",
        message: "\(error)"
      ))
    }
  }
} catch {
  failures.append(RemovalFailure(
    targetId: nil,
    code: "DESKTOP_UNINSTALL_HELPER_FAILED",
    message: "\(error)"
  ))
}

let status = failures.isEmpty ? "complete" : (removed.isEmpty ? "blocked" : "partial")
let resolvedReportPath = reportPath ?? ""
let report = RemovalReport(
  version: "kestrel_uninstall_completion_report_v1",
  executor: "desktop_helper",
  planId: resolvedPlanId,
  status: status,
  completedAt: ISO8601DateFormatter().string(from: Date()),
  removedTargets: removed,
  failures: failures,
  reportPath: resolvedReportPath
)
let reportData = try JSONEncoder().encode(report)
if let reportPath {
  let reportURL = URL(fileURLWithPath: reportPath)
  let temporaryURL = reportURL
    .deletingLastPathComponent()
    .appendingPathComponent(".\(reportURL.lastPathComponent).tmp-\(getpid())")
  try reportData.write(to: temporaryURL, options: .atomic)
  try FileManager.default.setAttributes(
    [.posixPermissions: 0o600],
    ofItemAtPath: temporaryURL.path
  )
  if rename(temporaryURL.path, reportURL.path) != 0 {
    throw HelperFailure(message: "unable to publish helper report")
  }
}
FileHandle.standardOutput.write(reportData)
FileHandle.standardOutput.write(Data("\n".utf8))
exit(failures.isEmpty ? 0 : 1)

func value(after flag: String, in arguments: [String]) -> String? {
  guard let index = arguments.firstIndex(of: flag) else { return nil }
  let valueIndex = arguments.index(after: index)
  guard valueIndex < arguments.endIndex else { return nil }
  return arguments[valueIndex]
}

func requireMode0600(_ inputPath: String) throws {
  var info = stat()
  if stat(inputPath, &info) != 0 {
    throw HelperFailure(message: "plan is unavailable")
  }
  let mode = (info.st_mode & S_IRWXU) | (info.st_mode & S_IRWXG) | (info.st_mode & S_IRWXO)
  if mode != (S_IRUSR | S_IWUSR) {
    throw HelperFailure(message: "plan must be mode 0600")
  }
}

func waitForParentExit(_ pid: Int32) {
  while kill(pid, 0) == 0 {
    Thread.sleep(forTimeInterval: 0.2)
  }
}

func readPlan(_ inputPath: String) throws -> [String: Any] {
  let data = try Data(contentsOf: URL(fileURLWithPath: inputPath))
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw HelperFailure(message: "plan must be a JSON object")
  }
  guard object["version"] as? String == "kestrel_uninstall_plan_v1" else {
    throw HelperFailure(message: "plan version is invalid")
  }
  return object
}

struct ValidatedTarget {
  let id: String
  let kind: String
  let path: String
  let selected: Bool
}

func validatedTargets(_ plan: [String: Any]) throws -> [ValidatedTarget] {
  guard let rawTargets = plan["targets"] as? [Any] else {
    throw HelperFailure(message: "plan targets must be an array")
  }
  return try rawTargets.enumerated().map { index, rawTarget in
    guard let target = rawTarget as? [String: Any],
          let id = target["id"] as? String,
          !id.isEmpty,
          let kind = target["kind"] as? String,
          !kind.isEmpty,
          let path = target["path"] as? String,
          !path.isEmpty,
          let selected = target["selected"] as? Bool else {
      throw HelperFailure(message: "plan target \(index) is malformed")
    }
    return ValidatedTarget(id: id, kind: kind, path: path, selected: selected)
  }
}

func removeDesktopBundle(_ inputPath: String) throws {
  let inputURL = URL(fileURLWithPath: inputPath)
  guard inputURL.pathExtension == "app" else {
    throw HelperFailure(message: "desktop target is not an app bundle")
  }
  guard FileManager.default.fileExists(atPath: inputURL.path) else {
    return
  }
  let allowedPaths = approvedDesktopBundlePaths()
  guard allowedPaths.contains(inputURL.standardizedFileURL.path) else {
    throw HelperFailure(message: "desktop target path is not approved")
  }
  try rejectSymlinkRoot(inputURL.path)
  try requireCurrentUserOwnership(inputURL.path)
  let url = inputURL.resolvingSymlinksInPath()
  guard try bundleIdentifier(at: url) == "com.kestrel.desktop" else {
    throw HelperFailure(message: "desktop bundle identifier is not com.kestrel.desktop")
  }
  let signature = try codeSignatureDetails(url.path)
  if !isApprovedReleaseSignature(signature) {
    throw HelperFailure(message: "desktop bundle is not a verified release-signed build")
  }
  try moveDesktopBundleToTrash(url)
}

func removeDesktopProfilePath(_ inputPath: String) throws {
  let inputURL = URL(fileURLWithPath: inputPath)
  let allowedPrefixes = approvedDesktopProfilePaths()
  guard allowedPrefixes.contains(where: { inputURL.path == $0 || inputURL.path.hasPrefix("\($0)/") }) else {
    throw HelperFailure(message: "profile target is outside verified Desktop paths")
  }
  guard FileManager.default.fileExists(atPath: inputURL.path) else {
    return
  }
  try rejectSymlinkRoot(inputURL.path)
  try requireCurrentUserOwnership(inputURL.path)
  let url = inputURL.resolvingSymlinksInPath()
  guard allowedPrefixes.contains(where: { url.path == $0 || url.path.hasPrefix("\($0)/") }) else {
    throw HelperFailure(message: "profile target resolves outside verified Desktop paths")
  }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
    return
  }
  try FileManager.default.removeItem(at: url)
}

func isApprovedReleaseSignature(_ signature: String) -> Bool {
#if KESTREL_UNINSTALL_TESTING
  if ProcessInfo.processInfo.environment["KESTREL_UNINSTALL_TEST_ALLOW_ADHOC"] == "1" {
    return signature.contains("Signature=adhoc")
  }
#endif
  return !signature.contains("Signature=adhoc")
    && signature.contains("Authority=Developer ID Application:")
}

func approvedDesktopBundlePaths() -> [String] {
#if KESTREL_UNINSTALL_TESTING
  if let root = ProcessInfo.processInfo.environment["KESTREL_UNINSTALL_TEST_ROOT"],
     !root.isEmpty {
    return [
      "\(root)/Applications/Kestrel.app",
      "\(root)/Home/Applications/Kestrel.app",
    ]
  }
#endif
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return [
    "/Applications/Kestrel.app",
    "\(home)/Applications/Kestrel.app",
  ]
}

func approvedDesktopProfilePaths() -> [String] {
#if KESTREL_UNINSTALL_TESTING
  if let root = ProcessInfo.processInfo.environment["KESTREL_UNINSTALL_TEST_ROOT"],
     !root.isEmpty {
    return desktopProfilePaths(home: "\(root)/Home")
  }
#endif
  return desktopProfilePaths(
    home: FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
  )
}

func desktopProfilePaths(home: String) -> [String] {
  return [
    "\(home)/Library/Application Support/Kestrel",
    "\(home)/Library/Application Support/@kestrel/desktop",
    "\(home)/Library/Preferences/com.kestrel.desktop.plist",
    "\(home)/Library/Caches/Kestrel",
    "\(home)/Library/Caches/com.kestrel.desktop",
    "\(home)/Library/Saved Application State/com.kestrel.desktop.savedState",
  ]
}

func moveDesktopBundleToTrash(_ url: URL) throws {
#if KESTREL_UNINSTALL_TESTING
  if let root = ProcessInfo.processInfo.environment["KESTREL_UNINSTALL_TEST_ROOT"],
     !root.isEmpty {
    let trash = URL(fileURLWithPath: root).appendingPathComponent("Trash")
    try FileManager.default.createDirectory(
      at: trash,
      withIntermediateDirectories: true
    )
    try FileManager.default.moveItem(
      at: url,
      to: trash.appendingPathComponent(url.lastPathComponent)
    )
    return
  }
#endif
  var trashed: NSURL?
  try FileManager.default.trashItem(at: url, resultingItemURL: &trashed)
}

func rejectSymlinkRoot(_ inputPath: String) throws {
  var info = stat()
  if lstat(inputPath, &info) != 0 {
    throw HelperFailure(message: "target is unavailable")
  }
  if (info.st_mode & S_IFMT) == S_IFLNK {
    throw HelperFailure(message: "refusing symlink target")
  }
}

func requireCurrentUserOwnership(_ inputPath: String) throws {
  var info = stat()
  if lstat(inputPath, &info) != 0 {
    throw HelperFailure(message: "target is unavailable")
  }
  if info.st_uid != geteuid() {
    throw HelperFailure(message: "target is not owned by the current user")
  }
}

func bundleIdentifier(at appURL: URL) throws -> String {
  let infoURL = appURL.appendingPathComponent("Contents/Info.plist")
  guard let info = NSDictionary(contentsOf: infoURL) as? [String: Any] else {
    throw HelperFailure(message: "desktop bundle Info.plist is unreadable")
  }
  guard let identifier = info["CFBundleIdentifier"] as? String else {
    throw HelperFailure(message: "desktop bundle identifier is missing")
  }
  return identifier
}

func codeSignatureDetails(_ appPath: String) throws -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  process.arguments = ["-dv", "--verbose=4", appPath]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe
  try process.run()
  process.waitUntilExit()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  let output = String(data: data, encoding: .utf8) ?? ""
  guard process.terminationStatus == 0 else {
    throw HelperFailure(message: "desktop bundle signature is unreadable")
  }
  return output
}
