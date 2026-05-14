# Sample session workspace

This folder is copied into every new VS Code session created via `POST /sessions`. Edit any file
and the host's `SampleVSCodeFiles` implementation will log the saved change to stdout, proving
the file-watch + debounce + `IVSCodeFiles.SaveAsync` round-trip is wired correctly.

Try:

- Open `hello.txt` and change its contents.
- Create a new file in this folder.
- Watch the test host's console log a `Session <id> saved ... <path>` line within ~500 ms.

When the session is deleted (`DELETE /sessions/<id>`) the workspace folder is removed from
disk; the host's implementation is given a final `SaveAsync` invocation first so any unsaved
edits are still persisted.
