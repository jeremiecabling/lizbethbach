-- Send one blue iMessage via Messages.app.
-- Usage: osascript send-imessage.applescript "<recipient handle>" "<message text>"
--
-- We explicitly target the iMessage service, so this can never go out as a green SMS:
-- if the recipient is not reachable on iMessage, the send raises an error (which the
-- caller records as FAILED) instead of silently downgrading.
--
-- The message text is passed as an argument (argv), never interpolated into the
-- script source, so quotes / emoji / apostrophes in the copy are handled verbatim.

on run argv
	if (count of argv) < 2 then error "expected 2 args: handle, text"
	set targetHandle to item 1 of argv
	set targetText to item 2 of argv
	tell application "Messages"
		set iMessageService to 1st service whose service type = iMessage
		set theBuddy to buddy targetHandle of iMessageService
		send targetText to theBuddy
	end tell
end run
