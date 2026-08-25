-- Send one iMessage. argv: handle, utf8 body path, optional chat guid
on run argv
  if (count of argv) < 2 then error "usage: handle body-path [chat-guid]"
  set targetHandle to item 1 of argv
  set messagePath to item 2 of argv
  set chatGuid to ""
  if (count of argv) ≥ 3 then set chatGuid to item 3 of argv
  set targetMessage to read (POSIX file messagePath) as «class utf8»
  tell application "Messages"
    if chatGuid is not "" then
      try
        send targetMessage to chat id chatGuid
        return "sent-chat"
      end try
    end if
    set targetAccount to 1st account whose service type = iMessage
    try
      set targetBuddy to participant targetHandle of targetAccount
      send targetMessage to targetBuddy
      return "sent-participant"
    on error
      send targetMessage to buddy targetHandle of targetAccount
      return "sent-buddy"
    end try
  end tell
end run
