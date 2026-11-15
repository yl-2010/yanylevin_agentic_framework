-- Send iMessage text. argv: handle, utf8 body path, chat guid (may be empty).
-- Extra args are file paths. Refuse them. Messages accepts `send POSIX file`
-- and returns success, then the attachment never arrives.
on run argv
  if (count of argv) < 3 then error "usage: handle body-path chat-guid"
  if (count of argv) > 3 then error "iMessage cannot attach files. Put the file on yanylevin.com and send the link. Email the file only when they asked for email."
  set targetHandle to item 1 of argv
  set messagePath to item 2 of argv
  set chatGuid to item 3 of argv
  set targetMessage to ""
  try
    set targetMessage to read (POSIX file messagePath) as «class utf8»
  end try
  if targetMessage is "" then error "nothing to send"
  tell application "Messages"
    if chatGuid is not "" then
      try
        send targetMessage to chat id chatGuid
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
      send targetMessage to targetBuddy
      return "sent-participant"
    on error
      set targetBuddy to buddy targetHandle of targetAccount
      send targetMessage to targetBuddy
      return "sent-buddy"
    end try
  end tell
end run
