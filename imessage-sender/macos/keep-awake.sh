#!/bin/bash
# Keep the Mac awake so scheduled sends fire even with the lid open / display off.
# launchd will not run the job while the Mac is asleep, so leave this running for the
# weekend. Open a Terminal window, run it, and leave the window open. Ctrl-C to stop.
#
# -d prevent display sleep, -i prevent idle sleep, -m prevent disk sleep,
# -s prevent system sleep (on AC power), -u declares user activity.
echo "Keeping this Mac awake. Leave this window open all weekend. Press Ctrl-C to stop."
exec caffeinate -dimsu
