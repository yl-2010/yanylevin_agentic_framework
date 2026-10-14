-- Open a WhatsApp chat by its display name and paste the clipboard.
-- argv: chat name, mode ("send" or "open")
-- The node side puts the message on the clipboard before send mode.
on run argv
	if (count of argv) < 1 then error "usage: chat-name [send|open]"
	set chatName to item 1 of argv
	set mode to "send"
	if (count of argv) ≥ 2 then set mode to item 2 of argv
	tell application "WhatsApp" to activate
	delay 0.35
	tell application "System Events"
		tell process "WhatsApp"
			set frontmost to true
			if (count of windows) is 0 then error "WhatsApp has no window"
			my wakeWindow()
			my closeSheet()
			my openChatByName(chatName)
			delay 0.45
			if (count of sheets of window 1) > 0 then error "WhatsApp did not open " & chatName
			if mode is "open" then return "open"
			my focusComposer()
			delay 0.15
			keystroke "a" using command down
			delay 0.08
			key code 51
			delay 0.12
			keystroke "v" using command down
			delay 0.35
			key code 36
			return "sent"
		end tell
	end tell
end run

on wakeWindow()
	tell application "System Events"
		tell process "WhatsApp"
			set p to position of window 1
			click at {(item 1 of p) + 180, (item 2 of p) + 220}
			delay 0.25
		end tell
	end tell
end wakeWindow

on closeSheet()
	tell application "System Events"
		tell process "WhatsApp"
			if (count of sheets of window 1) is 0 then return
			set closer to my findDescribed(sheet 1 of window 1, "close", 40)
			if closer is not missing value then
				my clickCenter(closer)
				delay 0.35
			end if
			if (count of sheets of window 1) > 0 then
				key code 53
				delay 0.25
			end if
		end tell
	end tell
end closeSheet

on chatIsOpen(chatName)
	tell application "System Events"
		tell process "WhatsApp"
			if (count of sheets of window 1) > 0 then return false
			set midX to my windowMidX()
			set hit to my findOnSide(window 1, chatName, midX, true, 60)
			return hit is not missing value
		end tell
	end tell
end chatIsOpen

on openChatByName(chatName)
	tell application "System Events"
		tell process "WhatsApp"
			set listHit to my findListButton(chatName)
			if listHit is not missing value then
				my pressRow(listHit)
				return
			end if
			click menu item 1 of menu 1 of menu bar item "File" of menu bar 1
			delay 0.55
			if (count of sheets of window 1) is 0 then error "New Chat sheet did not open"
			set area to my findRole(sheet 1 of window 1, "AXScrollArea", 50)
			if area is missing value then error "New Chat list missing"
			set wanted to my cleanName(chatName)
			repeat 8 times
				set rowEl to missing value
				repeat with k in (UI elements of area)
					if my cleanName(description of k) is wanted then
						set rowEl to k
						exit repeat
					end if
				end repeat
				if rowEl is not missing value then
					my pressRow(rowEl)
					return
				end if
				my pageList(area)
			end repeat
			error "No WhatsApp chat named " & chatName
		end tell
	end tell
end openChatByName

on pressRow(rowEl)
	tell application "System Events"
		tell process "WhatsApp"
			repeat with childEl in (UI elements of rowEl)
				try
					if "AXPress" is in (name of actions of childEl) then
						perform action "AXPress" of childEl
						delay 0.35
						return
					end if
				end try
			end repeat
			try
				if "AXPress" is in (name of actions of rowEl) then
					perform action "AXPress" of rowEl
					delay 0.35
				end if
			end try
		end tell
	end tell
end pressRow

on pageList(area)
	tell application "System Events"
		tell process "WhatsApp"
			perform action "AXScrollDownByPage" of area
			delay 0.2
		end tell
	end tell
end pageList

on focusComposer()
	tell application "System Events"
		tell process "WhatsApp"
			set p to position of window 1
			set s to size of window 1
			set cx to (item 1 of p) + (item 1 of s) * 0.75
			set cy to (item 2 of p) + (item 2 of s) - 50
			click at {cx, cy}
		end tell
	end tell
end focusComposer

on windowMidX()
	tell application "System Events"
		tell process "WhatsApp"
			set p to position of window 1
			set s to size of window 1
			return (item 1 of p) + (item 1 of s) / 2
		end tell
	end tell
end windowMidX

on clickCenter(el)
	tell application "System Events"
		tell process "WhatsApp"
			set p to position of el
			set s to size of el
			set cx to (item 1 of p) + (item 1 of s) / 2
			set cy to (item 2 of p) + (item 2 of s) / 2
			click at {cx, cy}
		end tell
	end tell
end clickCenter

on findRole(rootEl, roleName, cap)
	tell application "System Events"
		tell process "WhatsApp"
			set queue to {rootEl}
			set seen to 0
			repeat while (count of queue) > 0 and seen < cap
				set el to item 1 of queue
				if (count of queue) is 1 then
					set queue to {}
				else
					set queue to rest of queue
				end if
				set seen to seen + 1
				try
					if my asText(role of el) is roleName then return el
				end try
				if seen < cap - 5 then
					try
						set queue to queue & (UI elements of el)
					end try
				end if
			end repeat
		end tell
	end tell
	return missing value
end findRole

on findOnSide(rootEl, chatName, midX, wantRight, cap)
	set wanted to my cleanName(chatName)
	tell application "System Events"
		tell process "WhatsApp"
			set queue to {rootEl}
			set seen to 0
			repeat while (count of queue) > 0 and seen < cap
				set el to item 1 of queue
				if (count of queue) is 1 then
					set queue to {}
				else
					set queue to rest of queue
				end if
				set seen to seen + 1
				try
					if my cleanName(description of el) is wanted then
						set px to item 1 of (position of el)
						if wantRight and px ≥ midX then return el
						if wantRight is false and px < midX then return el
					end if
				end try
				if seen < cap - 5 then
					try
						set queue to queue & (UI elements of el)
					end try
				end if
			end repeat
		end tell
	end tell
	return missing value
end findOnSide

on asText(raw)
	try
		return raw as text
	end try
	return ""
end asText

on findListButton(chatName)
	set wanted to my cleanName(chatName)
	tell application "System Events"
		tell process "WhatsApp"
			set midX to my windowMidX()
			set queue to {window 1}
			set seen to 0
			repeat while (count of queue) > 0 and seen < 160
				set el to item 1 of queue
				if (count of queue) is 1 then
					set queue to {}
				else
					set queue to rest of queue
				end if
				set seen to seen + 1
				try
					set rs to role of el as text
					if (rs is "AXButton" or rs is "AXGenericElement") and my cleanName(description of el) is wanted then
						set px to item 1 of (position of el)
						if px < midX then return el
					end if
				end try
				if seen < 150 then
					try
						set queue to queue & (UI elements of el)
					end try
				end if
			end repeat
		end tell
	end tell
	return missing value
end findListButton

on buttonsNamed(chatName)
	set wanted to my cleanName(chatName)
	set out to {}
	tell application "System Events"
		tell process "WhatsApp"
			set queue to {UI element 1 of window 1}
			set seen to 0
			repeat while (count of queue) > 0 and seen < 180
				set el to item 1 of queue
				if (count of queue) is 1 then
					set queue to {}
				else
					set queue to rest of queue
				end if
				set seen to seen + 1
				try
					if role of el is "AXButton" then
						if my cleanName(description of el) is wanted then set end of out to el
					end if
				end try
				if seen < 140 then
					try
						set queue to queue & (UI elements of el)
					end try
				end if
			end repeat
		end tell
	end tell
	return out
end buttonsNamed

on findDescribed(rootEl, chatName, cap)
	set wanted to my cleanName(chatName)
	tell application "System Events"
		tell process "WhatsApp"
			set queue to {rootEl}
			set seen to 0
			repeat while (count of queue) > 0 and seen < cap
				set el to item 1 of queue
				if (count of queue) is 1 then
					set queue to {}
				else
					set queue to rest of queue
				end if
				set seen to seen + 1
				try
					if my cleanName(description of el) is wanted then return el
				end try
				if seen < cap - 5 then
					try
						set queue to queue & (UI elements of el)
					end try
				end if
			end repeat
		end tell
	end tell
	return missing value
end findDescribed

on cleanName(raw)
	set s to ""
	try
		set s to raw as text
	end try
	if s is "missing value" or s is "" then return ""
	set AppleScript's text item delimiters to character id 8206
	set parts to text items of s
	set AppleScript's text item delimiters to ""
	set s to parts as text
	set AppleScript's text item delimiters to character id 8207
	set parts to text items of s
	set AppleScript's text item delimiters to ""
	return parts as text
end cleanName
