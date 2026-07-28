import Foundation

struct HelperFailure: Error, CustomStringConvertible {
  let message: String
  var description: String { message }
}

struct RemovalReport: Encodable {
  let status: String
  let removed: [String]
  let failures: [String]
}

let arguments = CommandLine.arguments
let planPath = value(after: "--plan", in: arguments)
let parentPidText = value(after: "--parent-pid", in: arguments)

var removed: [String] = []
var failures: [String] = []

do {
  guard let planPath else {
    throw HelperFailure(message: "missing --plan")
  }
  try requireMode0600(planPath)
  if let parentPidText, let parentPid = Int32(parentPidText), parentPid > 0 {
    waitForParentExit(parentPid)
  }
  let plan = try readPlan(planPath)
  let targets = plan["targets"] as? [[String: Any]] ?? []
  for target in targets {
    guard (target["selected"] as? Bool) == true else { continue }
    guard let id = target["id"] as? String else { continue }
    guard let kind = target["kind"] as? String else { continue }
    guard let path = target["path"] as? String else { continue }
    do {
      switch kind {
      case "desktop_bundle":
        try removeDesktopBundle(path)
        removed.append(id)
      case "electron_profile", "preferences", "cache", "saved_state":
        try removeDesktopProfilePath(path)
        removed.append(id)
      default:
        continue
      }
    } catch {
      failures.append("\(id): \(error)")
    }
  }
} catch {
  failures.append("\(error)")
}

let status = failures.isEmpty ? "applied" : (removed.isEmpty ? "blocked" : "partial")
let report = RemovalReport(status: status, removed: removed, failures: failures)
let reportData = try JSONEncoder().encode(report)
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
  let mode = info.st_mode & S_IRWXU | info.st_mode & S_IRWXG | info.st_mode & S_IRWXO
  if mode != S_IRUSR | S_IWUSR {
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

func removeDesktopBundle(_ inputPath: String) throws {
  let inputURL = URL(fileURLWithPath: inputPath)
  try rejectSymlinkRoot(inputURL.path)
  let url = inputURL.resolvingSymlinksInPath()
  guard url.pathExtension == "app" else {
    throw HelperFailure(message: "desktop target is not an app bundle")
  }
  guard try bundleIdentifier(at: url) == "com.kestrel.desktop" else {
    throw HelperFailure(message: "desktop bundle identifier is not com.kestrel.desktop")
  }
  let signature = try codeSignatureDetails(url.path)
  if signature.contains("Signature=adhoc") || !signature.contains("Authority=Developer ID Application:") {
    throw HelperFailure(message: "desktop bundle is not a verified release-signed build")
  }
  var trashed: NSURL?
  try FileManager.default.trashItem(at: url, resultingItemURL: &trashed)
}

func removeDesktopProfilePath(_ inputPath: String) throws {
  let inputURL = URL(fileURLWithPath: inputPath)
  try rejectSymlinkRoot(inputURL.path)
  let url = inputURL.resolvingSymlinksInPath()
  let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
  let allowedPrefixes = [
    "\(home)/Library/Application Support/@kestrel/desktop",
    "\(home)/Library/Preferences/com.kestrel.desktop.plist",
    "\(home)/Library/Caches/com.kestrel.desktop",
    "\(home)/Library/Saved Application State/com.kestrel.desktop.savedState",
  ]
  guard allowedPrefixes.contains(where: { url.path == $0 || url.path.hasPrefix("\($0)/") }) else {
    throw HelperFailure(message: "profile target is outside verified Desktop paths")
  }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
    return
  }
  try FileManager.default.removeItem(at: url)
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
