-- Copy one Mail.app message into iCloud Colleges or Security and mark it read.
-- argv: destMailbox, srcAccount, srcMailbox, mailId, messageId
--
-- Gmail stores the message in All Mail and hangs INBOX on it as a label.
-- move to another account copies that message and leaves the Inbox label, so
-- the Gmail original is deleted after the copy. Mail's delete drops Inbox and
-- puts the Gmail message in Trash. Exchange and iCloud still use move.
on bareId(mid)
  if mid starts with "<" and mid ends with ">" then
    return text 2 thru -2 of mid
  end if
  return mid
end bareId

on run argv
  if (count of argv) < 5 then error "usage: dest srcAccount srcMailbox id message-id"
  set destName to item 1 of argv
  set srcAccount to item 2 of argv
  set srcBoxName to item 3 of argv
  set wantIdRaw to item 4 of argv
  set wantMid to item 5 of argv
  tell application "Mail"
    set dest to mailbox destName of account "iCloud"
    set theMsg to missing value
    try
      set srcBox to mailbox srcBoxName of account srcAccount
      if wantIdRaw is not "" then
        try
          set wantId to wantIdRaw as integer
          set theMsg to first message of srcBox whose id is wantId
        end try
      end if
      if theMsg is missing value and wantMid is not "" then
        try
          set theMsg to first message of srcBox whose message id is wantMid
        end try
        if theMsg is missing value then
          try
            set theMsg to first message of srcBox whose message id is my bareId(wantMid)
          end try
        end if
      end if
    end try
    if theMsg is missing value then error "message not found"
    set read status of theMsg to true
    if srcAccount is "Google" then
      duplicate theMsg to dest
      delete theMsg
    else
      move theMsg to dest
    end if
    return "moved"
  end tell
end run
