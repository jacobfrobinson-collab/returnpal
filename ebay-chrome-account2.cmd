@echo off
cd /d "%~dp0"
set EBAY_CHROME_USER_DATA_DIR=C:/Users/jacob/Desktop/ReturnPal/.ebay-chrome-profile-account2
set EBAY_PAYOUT_CHECKPOINT_PATH=C:/Users/jacob/Desktop/ReturnPal/.ebay-payout-checkpoint-account2.json
echo Account 2 Chrome profile
echo.
call npm run ebay:chrome
pause
