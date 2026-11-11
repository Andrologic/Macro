// Native launch bridge for the AgSDL content helper. It is not registered for
// production until cancellation and process termination have been qualified.
import Darwin
import Foundation
import LightweightCodeRequirements
import Security

private let helperArgument = "--macro-internal-agsdl-content-read"

@_cdecl("agsdl_content_macos_available")
public func agsdlContentMacosAvailable() -> Int32 {
    if #available(macOS 14.4, *) { return 1 }
    return 0
}

#if AGSDL_CONTENT_TESTING
// The harness uses this boundary to race an unrelated exec before fcntl.
var controlPipeCreatedHook: ((Int32, Int32) -> Void)?

private let qaSwapLock = NSLock()
private var qaPendingSwap: (target: String, replacement: String)?

// Arms one swap for the dedicated QA image. The replacement is applied only
// after launchRequirement is assigned and immediately before Process.run().
@_cdecl("agsdl_content_macos_qa_arm_swap")
public func agsdlContentMacosQaArmSwap(
    _ target: UnsafePointer<CChar>?, _ replacement: UnsafePointer<CChar>?
) -> Int32 {
    guard let target, let replacement,
          let targetPath = String(validatingUTF8: target),
          let replacementPath = String(validatingUTF8: replacement),
          targetPath.hasPrefix("/"), replacementPath.hasPrefix("/") else { return 1 }
    qaSwapLock.lock()
    defer { qaSwapLock.unlock() }
    guard qaPendingSwap == nil else { return 1 }
    qaPendingSwap = (targetPath, replacementPath)
    return 0
}

private func applyQaSwap(_ executablePath: String) -> Bool {
    qaSwapLock.lock()
    let swap = qaPendingSwap
    qaPendingSwap = nil
    qaSwapLock.unlock()
    guard let swap else { return true }
    guard swap.target == executablePath else { return false }
    return rename(swap.replacement, swap.target) == 0
}
#endif

// O_CLOEXEC is applied by openat atomically, including on macOS before pipe2.
// The FIFO is removed before the descriptors leave this function.
private func makeControlPipe() -> (Int32, Int32)? {
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("macro-content-XXXXXX")
    var template = Array(path.utf8CString)
    guard mkdtemp(&template) != nil else { return nil }
    let directory = String(cString: template)
    defer { _ = rmdir(directory) }
    let root = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard root >= 0 else { return nil }
    defer { close(root) }
    guard mkfifoat(root, "control", mode_t(S_IRUSR | S_IWUSR)) == 0 else { return nil }
    defer { _ = unlinkat(root, "control", 0) }
    let reader = openat(root, "control", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard reader >= 0 else { return nil }
    let writer = openat(root, "control", O_WRONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard writer >= 0 else { close(reader); return nil }
    var readInfo = stat()
    var writeInfo = stat()
    guard fstat(reader, &readInfo) == 0, fstat(writer, &writeInfo) == 0,
          readInfo.st_mode & S_IFMT == S_IFIFO,
          writeInfo.st_mode & S_IFMT == S_IFIFO,
          readInfo.st_dev == writeInfo.st_dev, readInfo.st_ino == writeInfo.st_ino else {
        close(reader)
        close(writer)
        return nil
    }
    // Do not hand out a writer if the FIFO still has a filesystem name: an
    // additional writer could otherwise prevent cancellation by EOF.
    guard unlinkat(root, "control", 0) == 0, fstat(reader, &readInfo) == 0,
          readInfo.st_nlink == 0 else {
        close(reader)
        close(writer)
        return nil
    }
    return (reader, writer)
}

// Signing information may come from mutable on-disk code. It is only a
// candidate until dynamic validation binds its hash to the running process.
private func runningCodeDirectoryHash() -> Data? {
    var selfCode: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &selfCode) == errSecSuccess,
          let selfCode else { return nil }
    var information: CFDictionary?
    let code = unsafeBitCast(selfCode, to: SecStaticCode.self)
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation),
                                        &information) == errSecSuccess,
          let dictionary = information as? [String: Any],
          let cdhash = dictionary[kSecCodeInfoUnique as String] as? Data,
          !cdhash.isEmpty else { return nil }
    let hex = cdhash.map { String(format: "%02x", $0) }.joined()
    let expression = "cdhash H\"\(hex)\"" as CFString
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(expression, SecCSFlags(), &requirement) == errSecSuccess,
          let requirement,
          SecCodeCheckValidity(selfCode, SecCSFlags(), requirement) == errSecSuccess else {
        return nil
    }
    return cdhash
}

private final class ContentLaunch {
    let process: Process
    let output: Pipe
    let finished: DispatchSemaphore
    init(process: Process, output: Pipe) {
        self.process = process
        self.output = output
        let finished = DispatchSemaphore(value: 0)
        self.finished = finished
        process.terminationHandler = { _ in finished.signal() }
    }
}

// The caller serializes access to the handle. A timeout leaves it owned by the
// caller; successful completion consumes it exactly once.
@_cdecl("agsdl_content_macos_wait_bounded")
public func agsdlContentMacosWaitBounded(
    _ raw: UnsafeMutableRawPointer?,
    _ timeoutMilliseconds: UInt32,
    _ status: UnsafeMutablePointer<Int32>?,
    _ signal: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard let raw, let status, let signal else { return 1 }
    let reference = Unmanaged<ContentLaunch>.fromOpaque(raw)
    let launch = reference.takeUnretainedValue()
    guard launch.finished.wait(timeout: .now() + .milliseconds(Int(timeoutMilliseconds))) == .success else {
        return 5
    }
    launch.process.waitUntilExit()
    status.pointee = launch.process.terminationStatus
    signal.pointee = launch.process.terminationReason == .uncaughtSignal ? 1 : 0
    reference.release()
    return 0
}

// Status values are part of the native bridge only, not an IPC contract.
// 0: launched; 1: invalid input; 2: unsupported OS or signing identity;
// 3: cannot create output pipe; 4: launch failed.
@_cdecl("agsdl_content_macos_launch")
public func agsdlContentMacosLaunch(
    _ executable: UnsafePointer<CChar>?,
    _ component: UnsafePointer<CChar>?,
    _ parentFD: Int32,
    _ result: UnsafeMutablePointer<UnsafeMutableRawPointer?>?,
    _ outputFD: UnsafeMutablePointer<Int32>?,
    _ controlFD: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard let result, let outputFD, let controlFD else { return 1 }
    result.pointee = nil
    outputFD.pointee = -1
    controlFD.pointee = -1
    guard let executable, let component, parentFD >= 0,
          let executablePath = String(validatingUTF8: executable),
          let name = String(validatingUTF8: component),
          executablePath.hasPrefix("/"), !name.isEmpty,
          name != ".", name != "..", !name.contains("/") else { return 1 }
    guard #available(macOS 14.4, *) else { return 2 }

    guard let cdhash = runningCodeDirectoryHash(), !cdhash.isEmpty else { return 2 }
    let requirement: LaunchCodeRequirement
    do { requirement = try LaunchCodeRequirement.allOf { CodeDirectoryHash(cdhash) } }
    catch { return 2 }

    let process = Process()
    let output = Pipe()
    guard let (controlRead, controlWrite) = makeControlPipe() else { return 3 }
    var transferred = false
    defer {
        close(controlRead)
        if !transferred { close(controlWrite) }
    }
    #if AGSDL_CONTENT_TESTING
    controlPipeCreatedHook?(controlRead, controlWrite)
    #endif
    let readFD = fcntl(output.fileHandleForReading.fileDescriptor, F_DUPFD_CLOEXEC, 3)
    guard readFD >= 0 else { return 3 }
    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = [helperArgument, "0", name]
    process.environment = [:]
    process.standardInput = FileHandle(fileDescriptor: parentFD, closeOnDealloc: false)
    process.standardOutput = output
    process.standardError = FileHandle(fileDescriptor: controlRead, closeOnDealloc: false)
    process.launchRequirement = requirement
    let launch = ContentLaunch(process: process, output: output)
    #if AGSDL_CONTENT_TESTING
    guard applyQaSwap(executablePath) else {
        close(readFD)
        return 6
    }
    #endif
    do { try process.run() }
    catch {
        close(readFD)
        return 4
    }
    result.pointee = Unmanaged.passRetained(launch).toOpaque()
    outputFD.pointee = readFD
    controlFD.pointee = controlWrite
    transferred = true
    return 0
}

// Wait consumes the handle only after Foundation reports termination. The
// caller must drain/close the output FD and must never wait on its UI thread.
@_cdecl("agsdl_content_macos_wait")
public func agsdlContentMacosWait(
    _ raw: UnsafeMutableRawPointer?,
    _ status: UnsafeMutablePointer<Int32>?,
    _ signal: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard let raw, let status, let signal else { return 1 }
    let launch = Unmanaged<ContentLaunch>.fromOpaque(raw).takeRetainedValue()
    launch.process.waitUntilExit()
    status.pointee = launch.process.terminationStatus
    signal.pointee = launch.process.terminationReason == .uncaughtSignal ? 1 : 0
    return 0
}
