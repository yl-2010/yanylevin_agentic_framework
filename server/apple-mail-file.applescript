-- Move one Mail.app message into iCloud Colleges or Security and mark it read.
-- argv: destMailbox, srcAccount, srcMailbox, mailId, messageId
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
      end if
    end try
    if theMsg is missing value then error "message not found"
    set read status of theMsg to true
    move theMsg to dest
    return "moved"
  end tell
end run
