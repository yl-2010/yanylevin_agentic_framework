-- Send iMessage files and/or text. Each file is its own message, then text.
-- argv: handle, utf8 body path, chat guid (may be empty), optional file paths
on run argv
  if (count of argv) < 3 then error "usage: handle body-path chat-guid [file...]"
  set targetHandle to item 1 of argv
  set messagePath to item 2 of argv
  set chatGuid to item 3 of argv
  set targetMessage to ""
  try
    set targetMessage to read (POSIX file messagePath) as «class utf8»
  end try
  set filePaths to {}
  if (count of argv) ≥ 4 then
    repeat with i from 4 to count of argv
      set end of filePaths to item i of argv
    end repeat
  end if
  if targetMessage is "" and (count of filePaths) is 0 then error "nothing to send"
  tell application "Messages"
    if chatGuid is not "" then
      try
        repeat with filePath in filePaths
          send (POSIX file (filePath as text)) to chat id chatGuid
        end repeat
        if targetMessage is not "" then
          send targetMessage to chat id chatGuid
        end if
        return "sent-chat"
      on error errMsg
        -- Only a phone or email may fall through to a buddy. A group
        -- display name must not become a new 1:1. Levin-Saha Family, 2026-09-30.
        set allowBuddy to false
        if targetHandle starts with "+" then set allowBuddy to true
        if targetHandle contains "@" then set allowBuddy to true
        if allowBuddy is false then error "Messages chat id failed (" & chatGuid & "): " & errMsg
      end try
    end if
    set targetAccount to 1st account whose service type = iMessage
    try
      set targetBuddy to participant targetHandle of targetAccount
      repeat with filePath in filePaths
        send (POSIX file (filePath as text)) to targetBuddy
      end repeat
      if targetMessage is not "" then
        send targetMessage to targetBuddy
      end if
      return "sent-participant"
    on error
      set targetBuddy to buddy targetHandle of targetAccount
      repeat with filePath in filePaths
        send (POSIX file (filePath as text)) to targetBuddy
      end repeat
      if targetMessage is not "" then
        send targetMessage to targetBuddy
      end if
      return "sent-buddy"
    end try
  end tell
end run
