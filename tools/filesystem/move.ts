import { cp, rename, rm } from "node:fs/promises";

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

export const fsMoveTool: SharedToolModule = {
  definition: {
    name: "fs.move",
    description: "Move a file or directory within the workspace or temp roots.",
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
    capability: createFileSystemCapability("fs.move", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Move Files",
      aliases: ["move files", "filesystem move", "rename path"],
      keywords: ["move", "rename", "filesystem", "path"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.move", input);
      const overwrite = readBoolean(body, "overwrite") ?? false;
      const sourceInput = assertString(body, "sourcePath", "fs.move requires input.sourcePath");
      const destinationInput = assertString(
        body,
        "destinationPath",
        "fs.move requires input.destinationPath",
      );
      const sourcePath = await resolveExistingFileSystemPath(
        sourceInput,
        context.fileSystem,
      );
      const destinationPath = await resolveTargetFileSystemPath(
        destinationInput,
        context.fileSystem,
      );
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: sourcePath.absolutePath, config: context.fileSystem, toolName: "fs.move", destructive: true });
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: destinationPath.absolutePath, config: context.fileSystem, toolName: "fs.move", destructive: true });
      await prepareDestinationForMutation({
        sourcePath,
        destinationPath,
        config: context.fileSystem,
        overwrite,
      });

      try {
        await rename(sourcePath.absolutePath, destinationPath.absolutePath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EXDEV") {
          throw error;
        }

        await cp(sourcePath.absolutePath, destinationPath.absolutePath, {
          recursive: true,
          force: overwrite,
          errorOnExist: overwrite === false,
        });
        await rm(sourcePath.absolutePath, {
          recursive: true,
          force: false,
        });
      }

      return {
        sourcePath: sourcePath.displayPath,
        destinationPath: destinationPath.displayPath,
        overwrite,
      };
    };
  },
};
