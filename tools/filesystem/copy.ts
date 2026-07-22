import { cp } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { assertString, parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  assertWorkspaceSkillStateMutationAllowed,
  createFileSystemPresentation,
  prepareDestinationForMutation,
  readBoolean,
  resolveExistingFileSystemPath,
  resolveTargetFileSystemPath,
} from "./shared.js";

export const fsCopyTool: SharedToolModule = {
  definition: {
    name: "fs.copy",
    description: "Copy a file or directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.copy", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Copy Files",
      aliases: ["copy files", "filesystem copy", "copy path"],
      keywords: ["copy", "filesystem", "file", "directory"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.copy", input);
      const overwrite = readBoolean(body, "overwrite") ?? false;
      const sourceInput = assertString(body, "sourcePath", "fs.copy requires input.sourcePath");
      const destinationInput = assertString(
        body,
        "destinationPath",
        "fs.copy requires input.destinationPath",
      );
      const sourcePath = await resolveExistingFileSystemPath(
        sourceInput,
        context.fileSystem,
      );
      const destinationPath = await resolveTargetFileSystemPath(
        destinationInput,
        context.fileSystem,
      );
      assertWorkspaceSkillStateMutationAllowed({
        absolutePath: destinationPath.absolutePath,
        config: context.fileSystem,
        toolName: "fs.copy",
        destructive: true,
      });
      await prepareDestinationForMutation({
        sourcePath,
        destinationPath,
        config: context.fileSystem,
        overwrite,
      });

      await cp(sourcePath.absolutePath, destinationPath.absolutePath, {
        recursive: true,
        force: overwrite,
        errorOnExist: overwrite === false,
      });

      return {
        sourcePath: sourcePath.displayPath,
        destinationPath: destinationPath.displayPath,
        overwrite,
      };
    };
  },
};
