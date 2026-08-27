# Local Browser Smoke Checklist

Run this checklist in order. It creates everything used by later checks, so it
does not depend on an existing Project, README, conversation, workflow, or Word
document.

For each section, record **Pass**, **Fail**, or **Blocked**, followed by a short
note. Take a screenshot when the screen does not match the expected result.

## 1. Start Kestrel One

- [ ] Open a terminal in the `kestrel-harness` folder and run:

  ```bash
  pnpm --filter @kestrel/kestrel-one dev:all
  ```

- [ ] Wait until the terminal says the application and local services are ready.
- [ ] Open `http://127.0.0.1:43103` in a browser.
- [ ] Sign in with the local administrator account printed in the terminal. The
      default account is `admin@dev.local` with password `devpass123` unless the
      local environment overrides it.
- [ ] Write down a unique run name, such as `SMOKE-2026-08-27-1100`. Use that
      same name throughout this checklist.

## 2. Create the test Project

- [ ] Open **Projects**.
- [ ] Click **New Project**.
- [ ] Enter `Local Smoke - YOUR-RUN-NAME` as the name.
- [ ] Enter `Disposable Project for the local browser smoke` as the description.
- [ ] Open **Add instructions now**.
- [ ] Enter the following instructions, replacing `YOUR-RUN-NAME` with the run
      name you wrote down:

  ```text
  This is the Local Smoke Project for YOUR-RUN-NAME.
  The Project verification code is ORIOLE-742.
  When asked for the verification code, answer with ORIOLE-742.
  ```

- [ ] Click **Create Project**.
- [ ] Open the Project you just created.
- [ ] Open the Project actions menu and select **Configure Workspace**.
- [ ] Select the local Environment.
- [ ] Select **Blank Workspace**.
- [ ] Click **Configure Workspace**.
- [ ] If the Workspace shows `Status: requested`, reload the page until it shows
      `Status: ready`.

## 3. Add OpenRouter and Luna

- [ ] Open **Organization → Connections**.
- [ ] Click **Add provider**.
- [ ] Select **OpenRouter**.
- [ ] Enter the OpenRouter API key used for this local test.
- [ ] Click **Add provider**.
- [ ] Confirm OpenRouter appears in the provider list without a connection error.
- [ ] Open **Organization → Models**.
- [ ] Select OpenRouter and click **Sync models**.
- [ ] Search for `openai/gpt-5.6-luna`.
- [ ] If Luna is not in the synchronized catalog, click **Add model**, enter
      `openai/gpt-5.6-luna` as the Provider model ID, choose **Language**, and
      click **Add approved model**.
- [ ] If Luna was added as already approved, click **Unapprove model** so the
      next section starts with an unavailable model.
- [ ] Confirm Luna is shown as **Unapproved** or otherwise not ready.
- [ ] Reload the Models page and confirm Luna remains unapproved.

## 4. Confirm an unavailable model cannot run

- [ ] Open `Local Smoke - YOUR-RUN-NAME`.
- [ ] Click **New Thread**.
- [ ] If the message box is disabled, confirm the page explains that setup is
      incomplete or that no model is ready. Continue with the approval steps
      below.
- [ ] If the message box is available, open the model picker.
- [ ] Confirm Luna is missing, disabled, or clearly shown as unavailable.
- [ ] If the page allows you to select Luna, try sending:

  > Reply with LUNA-SHOULD-NOT-RUN.

- [ ] Confirm no response from Luna is produced. If you could press Send,
      confirm Kestrel blocks the request and explains that the model is not
      available.
- [ ] Return to **Organization → Models**.
- [ ] Find Luna and click **Approve model**.
- [ ] Confirm the row shows **Checking compatibility**.
- [ ] Wait until the row shows **Ready**.
- [ ] If Luna is not already the default, click **Make default**.
- [ ] Reload the Models page and confirm Luna is still Ready.
- [ ] Return to the test Project and start a new Thread.
- [ ] Select Luna and send:

  > What is this Project's verification code? Answer with only the code.

- [ ] Confirm the answer is `ORIOLE-742`.

## 5. Check the approval flow

- [ ] In the test Project, start a new Thread.
- [ ] Send:

  > Run `sleep 3 && pwd` and tell me the result.

- [ ] Confirm an approval card appears before the command runs.
- [ ] Confirm the card shows `sleep 3 && pwd` and does not hide or change the
      command.
- [ ] Click **Approve Once**.
- [ ] Confirm the card changes from waiting for approval to running.
- [ ] Confirm one command result appears and Kestrel reports the folder.
- [ ] Confirm the approval card is no longer waiting for a decision.
- [ ] Reload the Thread.
- [ ] Confirm the completed result remains and the approval does not return to a
      pending state.

### Decline

- [ ] Send:

  > Run `node --version` and tell me the result.

- [ ] Click **Decline**.
- [ ] Confirm the command does not produce a version result.
- [ ] Confirm Kestrel clearly says the action was declined or did not run.

### Remember approval

- [ ] Start another new Thread in the same Project.
- [ ] Send:

  > Run `pwd` and tell me the result.

- [ ] Click **Remember Approval**.
- [ ] Wait for the command to finish.
- [ ] Send:

  > Run `pwd` again. Do not reuse the previous result.

- [ ] Confirm `pwd` runs again without another approval card.
- [ ] Start a different Thread and send:

  > Run `pwd` and tell me the result.

- [ ] Confirm the new Thread asks for approval.

## 6. Change mode while a request is waiting

- [ ] Start a new Thread in the test Project.
- [ ] Make sure the mode is **Chat**.
- [ ] Send this message, replacing `YOUR-RUN-NAME`:

  > Create a file named `mode-switch-YOUR-RUN-NAME.txt` containing
  > `MODE-SWITCH-COMPLETE`, then tell me when it is done.

- [ ] Wait for the approval card. Do not approve it yet.
- [ ] Change the mode from **Chat** to **Build**.
- [ ] Click **Approve Once** on the original request.
- [ ] Confirm the original request continues instead of disappearing or starting
      over.
- [ ] Confirm there is only one copy of the user's message.
- [ ] Confirm Kestrel reports that the file was created.
- [ ] Confirm the mode still shows **Build** after the request finishes.
- [ ] Send:

  > Read `mode-switch-YOUR-RUN-NAME.txt` and tell me its contents.

- [ ] Approve the read if asked.
- [ ] Confirm the result is `MODE-SWITCH-COMPLETE`.

## 7. Keep Project information across tabs

- [ ] In tab A, open the test Project and start a new Thread.
- [ ] Ask:

  > What is this Project's verification code? Answer with only the code.

- [ ] Confirm tab A answers `ORIOLE-742`.
- [ ] In tab A, send:

  > Run `pwd` and tell me the result.

- [ ] Approve the command and wait for Kestrel to report the folder.
- [ ] Open tab B.
- [ ] Open the same Project and start a different Thread.
- [ ] Ask the same verification-code question.
- [ ] Confirm tab B answers `ORIOLE-742`.
- [ ] Return to tab A and ask:

  > Repeat the Project verification code.

- [ ] Confirm tab A still answers `ORIOLE-742`.
- [ ] Visit another Kestrel One page, then return to the Thread in tab A.
- [ ] Ask for the verification code again.
- [ ] Confirm the answer remains `ORIOLE-742`.
- [ ] Confirm neither Thread says it lost access to the Project, asks you to
      reconnect the Project, or tells you to retry because Project information
      could not be continued.

An approval for a new terminal command is not a failure here. This section is
checking that both Threads keep the Project name and instructions.

## 8. Approve a command and create a Word document

- [ ] Start a new Thread in the test Project.
- [ ] Send the following message, replacing `YOUR-RUN-NAME`:

  > Run `pwd`. Then create a Word document named
  > `approval-word-YOUR-RUN-NAME.docx`. Give it the heading `Local Smoke
  > YOUR-RUN-NAME` and include the folder reported by `pwd` and the Project
  > verification code.

- [ ] Confirm the approval card appears for `pwd`.
- [ ] Click **Approve Once**.
- [ ] Confirm the same request continues after the command finishes.
- [ ] Confirm one Word document appears in the response.
- [ ] Download the document.
- [ ] Open it and confirm it contains:
  - [ ] `Local Smoke YOUR-RUN-NAME`;
  - [ ] the folder reported by `pwd`;
  - [ ] `ORIOLE-742`.
- [ ] Reload the Thread.
- [ ] Confirm the completed command result and Word download are still present.
- [ ] Confirm there is only one document with that name in the response.

## 9. Create and run a workflow

This test creates exactly two boxes: a manual start and a final output.

- [ ] Open **Workflows**.
- [ ] Click **New workflow**.
- [ ] In **Details**, select the test Project and Luna.
- [ ] Name the workflow `Local Smoke Workflow - YOUR-RUN-NAME`.
- [ ] Choose **Start manually** if the workflow generator is open.
- [ ] Keep the existing **Run manually** and **Workflow output** boxes.
- [ ] Double-click the existing **Kestrel step** box and click **Delete step**.
- [ ] Connect the two remaining boxes in this order:

  ```text
  Run manually → Workflow output
  ```

- [ ] Click **Save version**.
- [ ] Confirm the workflow saves without a graph error.
- [ ] Click **Run**.
- [ ] Confirm the run finishes successfully.
- [ ] Confirm both boxes show as completed.
- [ ] Confirm the run page displays a final output, even if that output is an
      empty object because the manual start did not receive input.
- [ ] Reload the run page.
- [ ] Confirm the completed run and final output remain visible.

## 10. Use a named collaborator without filling the main chat

There is no Quiet Mode switch to turn on. The expected behavior is that the
private exchange stays in the Collaborators panel while the main chat shows only
Kestrel's final summary.

- [ ] Start a new Thread in the test Project.
- [ ] Send:

  > Create a collaborator named Researcher. Ask Researcher to calculate 17 × 23,
  > wait for the reply, tell me the answer, and then close Researcher.

- [ ] Open the **Collaborators** panel.
- [ ] Confirm a collaborator named **Researcher** appears.
- [ ] Confirm Researcher shows as working, then ready or archived after it
      finishes.
- [ ] Confirm the private messages between Kestrel and Researcher appear only in
      the Collaborators panel, not as normal messages in the main chat.
- [ ] Confirm a new pop-up or banner does not appear for every private message.
- [ ] Confirm the main chat contains one clear summary from Kestrel.
- [ ] Confirm the reported answer is `391`.
- [ ] Reload the Thread.
- [ ] Confirm Researcher and its completed conversation remain available in the
      Collaborators panel.

## 11. Restart while an approval is waiting

- [ ] Start a new Thread in the test Project.
- [ ] Send:

  > Run `node --version` and tell me the result.

- [ ] Wait for the approval card. Do not choose an option.
- [ ] Copy the Thread's browser address now that the first message has created
      the Thread.
- [ ] Return to the terminal running Kestrel One and press **Control-C**.
- [ ] Do not reset the database, remove Docker volumes, or delete local storage.
- [ ] Start Kestrel One again with the same command:

  ```bash
  pnpm --filter @kestrel/kestrel-one dev:all
  ```

- [ ] Wait until the local services are ready.
- [ ] Reopen the saved Thread address.
- [ ] Confirm the approval card is still waiting.
- [ ] Click **Approve Once**.
- [ ] Confirm one Node.js version result appears.
- [ ] Reload the Thread and confirm the approval remains completed.

## 12. Run a fresh approval and Word export after restart

- [ ] After the restart, open the test Project and start a new Thread.
- [ ] Send the following message, replacing `YOUR-RUN-NAME`:

  > Run `pwd`. Then create a Word document named
  > `after-restart-YOUR-RUN-NAME.docx` with the heading `After Restart` and the
  > text `ORIOLE-742`.

- [ ] Confirm a new approval card appears.
- [ ] Click **Approve Once**.
- [ ] Confirm the command finishes and one new Word document appears.
- [ ] Download and open the document.
- [ ] Confirm it contains `After Restart` and `ORIOLE-742`.
- [ ] Confirm the new Thread does not show the approval card, messages, or Word
      document from the pre-restart Thread.

## 13. Finish the run

- [ ] Review every section and make sure each one has a Pass, Fail, or Blocked
      result.
- [ ] Save screenshots and the Kestrel terminal output for every failure.
- [ ] Record the run name, date, and browser.
- [ ] In the `kestrel-harness` terminal, run `git rev-parse --short HEAD` and
      record the commit shown.
- [ ] If this Project was created only for the smoke, archive or delete it after
      you finish collecting evidence.
- [ ] Remove the OpenRouter connection only if it was created solely for this
      smoke and is not used by other local work.
