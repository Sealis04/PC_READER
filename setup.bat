@echo off
rem ======================================================================
rem PC_READER server - guided setup for Windows (Docker only).
rem
rem   1. Development: this PC, database also on 127.0.0.1 for bun dev / tests.
rem   2. Production:  this PC/server; PCs on the LAN connect to http://<IP>:<port>.
rem   Either one can add a Cloudflare Tunnel for an https address.
rem
rem Safe to run again: it keeps or backs up the env file (keeping the enrollment
rem and secrets keys), re-applies the database password, and migrations only
rem apply what is missing. setup.sh is the Linux/macOS twin; keep them in step.
rem ======================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title PC_READER setup

echo.
echo  PC_READER setup
echo  ===============
echo.
call :need_docker || goto :failed

echo Which setup is this?
echo   1. Development  - this PC, for trying it out and working on the code
echo   2. Production   - the server the agency's PCs report to
choice /c 12 /n /m "Pick 1 or 2: "
if errorlevel 2 (set "ENV=prod") else (set "ENV=dev")
echo.
goto :web_%ENV%

:web_dev
set "PROJECT=pcreader-dev"
set "ENVFILE=.env"
set "FILES=-f docker-compose.yml -f compose.local.yml"
goto :configure

:web_prod
set "PROJECT=pcreader"
set "ENVFILE=.env.prod"
set "FILES=-f docker-compose.yml"
goto :configure


rem ======================================================================
rem Env file: keep it, or write a new one
rem ======================================================================
:configure
call :env_file_choice || goto :failed

rem KEYSRC: an older env file whose keys a new one should keep. PROJSRC: where the project name is.
set "KEYSRC="
set "PROJSRC="
if "%WRITE_ENV%"=="0" (
  set "PROJSRC=%ENVFILE%"
) else if defined BACKUP (
  set "KEYSRC=%BACKUP%"
  set "PROJSRC=%BACKUP%"
) else if "%ENV%"=="prod" if exist ".env" set "KEYSRC=.env"

set "SAVED_PROJECT="
if defined PROJSRC call :readfile "%PROJSRC%" COMPOSE_PROJECT_NAME "" SAVED_PROJECT
if defined SAVED_PROJECT (
  set "PROJECT=!SAVED_PROJECT!"
) else (
  call :pick_project || goto :failed
)
set "DC=docker compose -p %PROJECT% --env-file %ENVFILE% %FILES%"
if "%WRITE_ENV%"=="0" (
  call :setenv COMPOSE_PROJECT_NAME "%PROJECT%" || goto :failed
  goto :run
)

echo Press Enter to accept the value in [brackets].
call :show_used_ports
call :ask_port APP_PORT "Port PCs and browsers use to reach the server" 3000 %PROJECT%-app-1
set "DB_PORT="
if "%ENV%"=="dev" call :ask_port DB_PORT "Port for the database on this PC, for bun dev and tests only" 5432 %PROJECT%-db-1

set "OLD_TZ=Asia/Manila"
if defined KEYSRC call :readfile "%KEYSRC%" DISPLAY_TIMEZONE "Asia/Manila" OLD_TZ
echo Time zone of the dashboard, the inventory number year and the hourly IT PIN.
call :ask DISPLAY_TIMEZONE "IANA time zone" "!OLD_TZ!"

call :keys || goto :failed
call :randhex 24 POSTGRES_PASSWORD || goto :failed
set "APP_BIND=0.0.0.0"
set "PUBLIC_URL="
set "CLOUDFLARE_TUNNEL_TOKEN="
call :write_env || goto :failed
echo.
echo Wrote %ENVFILE% with a new random database password.
if "%ENV%"=="prod" (
  echo.
  echo IMPORTANT: copy %ENVFILE% into your password manager now. SECRETS_KEY in it
  echo decrypts the secret custom fields; without it they are lost with this PC.
  echo.
  pause
)
echo.
call :ask_tunnel || goto :failed
goto :run


rem ======================================================================
rem Shared steps for both paths
rem ======================================================================
:run
call :readenv APP_PORT 3000
call :readenv APP_BIND 0.0.0.0
call :readenv PUBLIC_URL ""
call :ensure_port APP_PORT %PROJECT%-app-1 || goto :failed
if "%ENV%"=="dev" (
  call :readenv DB_PORT 5432
  call :ensure_port DB_PORT %PROJECT%-db-1 || goto :failed
)
call :readenv ENROLLMENT_KEY ""
if not defined ENROLLMENT_KEY (
  echo %ENVFILE% has no ENROLLMENT_KEY. Run setup.bat again and choose Replace.
  goto :failed
)
set "ENROLLMENT_KEY="
set "PROFILE="
call :readenv CLOUDFLARE_TUNNEL_TOKEN ""
if defined CLOUDFLARE_TUNNEL_TOKEN set "PROFILE=--profile tunnel"
set "CLOUDFLARE_TUNNEL_TOKEN="

echo.
echo [1/5] Building the server image. The first build takes a few minutes...
call :run_step "%DC% build migrate app" || goto :failed

echo.
echo [2/5] Starting the database...
call :run_step "%DC% up -d --wait db" || goto :failed

echo.
echo [3/5] Setting the database password from %ENVFILE%...
rem Postgres takes POSTGRES_PASSWORD only when it creates its volume. Apply it to an
rem existing volume as well, so a re-written %ENVFILE% still matches the data.
call :run_step "%DC% exec -T db sh < scripts\reset-db-password.sh" || goto :failed

echo.
echo [4/5] Applying database migrations...
call :run_step "%DC% run --rm migrate" || goto :failed

echo.
echo [5/5] Starting the server...
call :run_step "%DC% %PROFILE% up -d" || goto :failed
call :wait_health "http://127.0.0.1:%APP_PORT%/api/branding" || goto :failed

if not "%APP_BIND%"=="127.0.0.1" call :firewall

echo.
echo ======================================================================
echo  Ready. Dashboard: http://localhost:%APP_PORT%
echo ======================================================================
echo.
if not "%APP_BIND%"=="127.0.0.1" (
  echo PCs on the network use one of these server addresses:
  powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike 'vEthernet*' } | ForEach-Object { '  http://' + $_.IPAddress + ':%APP_PORT%' }"
)
if defined PUBLIC_URL echo Through the tunnel: %PUBLIC_URL%
echo.
echo Setting up a PC: install the desktop app, enter the server address above,
echo the enrollment key ^(ENROLLMENT_KEY in %ENVFILE%^) and the current IT PIN
echo from http://localhost:%APP_PORT%/it-pin
echo.
echo After a code change or git pull, rebuild and restart ^(migrations run on start^):
echo   %DC% %PROFILE% up -d --build
echo Stop it - the data stays in Docker volumes:
echo   %DC% %PROFILE% down
echo Logs:
echo   %DC% logs -f app
echo.
goto :leftovers_%ENV%

:leftovers_dev
echo To run the server with bun dev instead, keep this database running and
echo stop only the app container:
echo   %DC% stop app
echo   set DATABASE_URL=postgres://pcreader:^<POSTGRES_PASSWORD from .env^>@127.0.0.1:%DB_PORT%/pcreader
echo   cd server ^&^& bun run dev
echo.
call :leftovers_tunnel
pause
exit /b 0

:leftovers_prod
echo Still to do by hand:
echo  - The dashboard has no login yet: anyone who can open it can read the IT PIN.
echo    Keep it on the office network.
echo  - Docker Desktop: Settings, General, "Start Docker Desktop when you sign in",
echo    and keep this PC from sleeping. The containers restart on their own.
echo  - Keep %ENVFILE% in a password manager. A lost SECRETS_KEY means lost secret fields.
echo  - Give this server a fixed IP ^(DHCP reservation^) so PCs keep finding it.
echo  - Back up regularly, e.g. a nightly Task Scheduler job:
echo      %DC% exec -T db pg_dump -U pcreader -Fc pcreader ^> pcreader.dump
echo.
call :leftovers_tunnel
pause
exit /b 0

:leftovers_tunnel
if not defined PROFILE (
  echo To add a Cloudflare Tunnel later, run setup.bat again and choose Replace;
  echo the enrollment key and SECRETS_KEY are kept.
  echo.
  exit /b 0
)
echo Tunnel is on. In Cloudflare:
echo  - The public hostname must point to Service HTTP, URL app:3000. The tunnel
echo    should show HEALTHY.
echo  - Put a Cloudflare Access application on the hostname: the dashboard has no
echo    login and shows the IT PIN. Add a Bypass policy for the paths PCs use:
echo    /api/agent/* and /api/branding* ^(they carry their own token / are public^).
echo  - This PC must stay awake, or Cloudflare shows error 1033.
echo.
exit /b 0

:failed
echo.
echo Setup stopped. Fix the problem above and run setup.bat again;
echo finished steps are kept or are safe to repeat.
pause
exit /b 1


rem ======================================================================
rem Helpers. Call with `call :name args`; each returns errorlevel 0 on success.
rem ======================================================================

:need_docker
where docker >nul 2>&1 || (
  echo Docker is not installed. Install Docker Desktop ^(WSL 2 engine^), then run this again.
  exit /b 1
)
docker info >nul 2>&1 || (
  echo Docker is not running. Start Docker Desktop, wait for "Engine running", run this again.
  exit /b 1
)
docker compose version >nul 2>&1 || (
  echo This Docker has no "docker compose". Update Docker Desktop, then run this again.
  exit /b 1
)
exit /b 0

rem Sets WRITE_ENV=1 when %ENVFILE% should be (re)written, and BACKUP to the copy of the old one.
:env_file_choice
set "WRITE_ENV=1"
set "BACKUP="
if not exist "%ENVFILE%" exit /b 0
echo %ENVFILE% already exists here.
choice /c KR /m "[K]eep it, or [R]eplace it (the old one is saved as %ENVFILE%.bak-..., its keys can be kept)"
if not errorlevel 2 (
  set "WRITE_ENV=0"
  exit /b 0
)
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "BACKUP=%ENVFILE%.bak-%STAMP%"
copy /y "%ENVFILE%" "%BACKUP%" >nul || exit /b 1
echo Saved the old file as %BACKUP%
echo.
exit /b 0

rem :pick_project  -> PROJECT stays the default unless an earlier `docker compose up` (run by hand,
rem project named after the folder) left a database volume the user wants to keep using.
:pick_project
docker volume inspect %PROJECT%_pgdata >nul 2>&1 && exit /b 0
set "NCAND=0"
for /f "delims=" %%v in ('docker volume ls -q --filter "label=com.docker.compose.volume=pgdata" 2^>nul') do (
  set "VOL=%%v"
  set "VPROJ=!VOL:~0,-7!"
  if /i not "!VPROJ!"=="pcreader" if /i not "!VPROJ!"=="pcreader-dev" (
    set /a NCAND+=1
    set "CAND!NCAND!=!VPROJ!"
  )
)
set "I=0"
:pick_project_next
if !I! geq !NCAND! exit /b 0
set /a I+=1
set "VPROJ=!CAND%I%!"
echo Found a database volume "!VPROJ!_pgdata" from an earlier docker compose run.
choice /c YN /m "Is that this PC_READER server's data, to keep using"
if errorlevel 2 goto :pick_project_next
set "PROJECT=!VPROJ!"
echo Using project "!PROJECT!", so its data is kept.
echo.
exit /b 0

rem :keys  -> ENROLLMENT_KEY, SECRETS_KEY, IT_PIN_SECRET: from %KEYSRC% when asked, else new ones.
rem A new SECRETS_KEY makes saved secret fields unreadable; a new ENROLLMENT_KEY breaks the
rem offline Settings fallback on PCs that were set up with the old one.
:keys
set "ENROLLMENT_KEY="
set "SECRETS_KEY="
set "IT_PIN_SECRET="
if defined KEYSRC (
  call :readfile "%KEYSRC%" ENROLLMENT_KEY ""
  call :readfile "%KEYSRC%" SECRETS_KEY ""
  call :readfile "%KEYSRC%" IT_PIN_SECRET ""
)
if defined ENROLLMENT_KEY (
  choice /c YN /m "Keep ENROLLMENT_KEY, SECRETS_KEY and IT_PIN_SECRET from %KEYSRC% (Y unless you mean to change them)"
  if errorlevel 2 (
    set "ENROLLMENT_KEY="
    set "SECRETS_KEY="
    set "IT_PIN_SECRET="
  )
)
if not defined ENROLLMENT_KEY (
  call :randhex 12 GEN_KEY || exit /b 1
  echo IT types the enrollment key when setting up each PC. Letters, digits and -, at least 12.
  call :ask_enrollment_key
)
if not defined SECRETS_KEY call :randb64 32 SECRETS_KEY || exit /b 1
exit /b 0

:ask_enrollment_key
call :ask ENROLLMENT_KEY "Enrollment key" "!GEN_KEY!"
powershell -NoProfile -Command "if ('%ENROLLMENT_KEY%' -cmatch '^[A-Za-z0-9-]{12,}$') { exit 0 } else { exit 1 }" >nul 2>&1 && exit /b 0
echo   Use at least 12 letters, digits or -.
goto :ask_enrollment_key

rem Writes %ENVFILE% from the variables set above. Never echoed to the screen.
:write_env
> "%ENVFILE%" (
  echo # Written by setup.bat. Keep it private; Git ignores it.
  echo # Read by docker compose through --env-file. See .env.example for what each value does.
  echo COMPOSE_PROJECT_NAME=!PROJECT!
  echo.
  echo # --- Server ---
  echo # IT types this when setting up a PC. Keep it when re-writing this file.
  echo ENROLLMENT_KEY=!ENROLLMENT_KEY!
  echo # Decrypts the secret custom fields. Back it up with the database; lost key = lost secrets.
  echo SECRETS_KEY=!SECRETS_KEY!
  echo # Empty: the server keeps its own IT PIN secret in the database.
  echo IT_PIN_SECRET=!IT_PIN_SECRET!
  echo DISPLAY_TIMEZONE=!DISPLAY_TIMEZONE!
  echo CHECKIN_INTERVAL_SECONDS=300
  echo.
  echo # --- Database ---
  echo POSTGRES_PASSWORD=!POSTGRES_PASSWORD!
  echo # Development only: the database on 127.0.0.1 for bun dev and tests.
  echo DB_PORT=!DB_PORT!
  echo.
  echo # --- Network ---
  echo APP_PORT=!APP_PORT!
  echo # 0.0.0.0: PCs on the LAN connect directly. 127.0.0.1: only this PC and the tunnel.
  echo APP_BIND=!APP_BIND!
  echo # https address of the Cloudflare Tunnel, if any ^(shown at the end of setup^).
  echo PUBLIC_URL=!PUBLIC_URL!
  echo CLOUDFLARE_TUNNEL_TOKEN=!CLOUDFLARE_TUNNEL_TOKEN!
) || exit /b 1
exit /b 0

rem :ask VAR "Prompt" "default"
:ask
set "%~1="
if "%~3"=="" (set /p "%~1=%~2: ") else (set /p "%~1=%~2 [%~3]: ")
if not defined %~1 set "%~1=%~3"
exit /b 0

rem :ask_required VAR "Prompt"
:ask_required
set "%~1="
set /p "%~1=%~2: "
if not defined %~1 (
  echo   This one is required.
  goto :ask_required
)
exit /b 0

rem :randhex BYTES VAR  -> VAR = 2*BYTES hex characters from the OS cryptographic RNG
:randhex
set "%~2="
for /f %%h in ('powershell -NoProfile -Command "$b = New-Object byte[] %~1; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [BitConverter]::ToString($b).Replace('-','').ToLower()"') do set "%~2=%%h"
if not defined %~2 (
  echo Could not generate a random secret with PowerShell.
  exit /b 1
)
exit /b 0

rem :randb64 BYTES VAR  -> VAR = BYTES random bytes, base64 (SECRETS_KEY format)
:randb64
set "%~2="
for /f %%h in ('powershell -NoProfile -Command "$b = New-Object byte[] %~1; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)"') do set "%~2=%%h"
if not defined %~2 (
  echo Could not generate a random secret with PowerShell.
  exit /b 1
)
exit /b 0

rem :readfile "file" KEY default [OUTVAR]  -> OUTVAR (or KEY) = KEY's value in that env file, else default
:readfile
set "RF_OUT=%~4"
if not defined RF_OUT set "RF_OUT=%~2"
set "%RF_OUT%=%~3"
if not exist "%~1" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~1") do if /i "%%a"=="%~2" set "%RF_OUT%=%%b"
exit /b 0

rem :readenv VAR default  -> VAR from %ENVFILE%, else default
:readenv
call :readfile "%ENVFILE%" %1 %2
exit /b 0

rem :setenv VAR "value"  -> sets VAR=value in %ENVFILE%, replacing its line or adding one
:setenv
powershell -NoProfile -Command "$f='%ENVFILE%'; $k='%~1'; $v='%~2'; $l=@(Get-Content $f); if ($l | Where-Object { $_.StartsWith($k + '=') }) { $l = $l | ForEach-Object { if ($_.StartsWith($k + '=')) { $k + '=' + $v } else { $_ } } } else { $l += ($k + '=' + $v) }; Set-Content $f $l" || exit /b 1
set "%~1=%~2"
exit /b 0

rem :show_used_ports  -> lists the ports running Docker containers publish on this PC
:show_used_ports
set "ANY_USED="
for /f "tokens=1,*" %%a in ('docker ps --format "{{.Names}} {{.Ports}}" 2^>nul') do (
  if not "%%b"=="" (
    if not defined ANY_USED echo Ports already taken by running Docker containers:
    set "ANY_USED=1"
    echo   %%a  %%b
  )
)
if defined ANY_USED echo.
exit /b 0

rem :port_holder PORT own  -> HOLDER = what uses PORT on this PC, empty when it is free or held
rem by our own container `own` (docker compose recreates that one). Docker is asked first:
rem Docker Desktop can publish a port without netstat showing it as LISTENING.
:port_holder
set "HOLDER="
set "OWNED="
for /f "delims=" %%n in ('docker ps --filter "publish=%~1" --format "{{.Names}}" 2^>nul') do (
  if /i "%%n"=="%~2" (set "OWNED=1") else if not defined HOLDER set "HOLDER=Docker container %%n"
)
if defined OWNED (
  set "HOLDER="
  exit /b 0
)
if defined HOLDER exit /b 0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:%~1 .*LISTENING"') do (
  if not defined HOLDER (
    set "HOLDER=a program, PID %%p"
    for /f "tokens=1 delims=," %%t in ('tasklist /fi "PID eq %%p" /fo csv /nh') do set "HOLDER=program %%~t, PID %%p"
  )
)
exit /b 0

rem :free_port START own  -> FREE_PORT = the first port from START up that :port_holder finds free
:free_port
set /a FREE_PORT=%~1
set /a FREE_LAST=%~1+100
:free_port_next
call :port_holder !FREE_PORT! %~2
if not defined HOLDER exit /b 0
if !FREE_PORT! geq !FREE_LAST! exit /b 0
set /a FREE_PORT+=1
goto :free_port_next

rem :ask_port VAR "Prompt" default own  -> asks for a port, suggesting the first free one from
rem `default`; if the answer is taken, says by what and asks again.
:ask_port
set "FREE_PORT=%~3"
call :port_holder %~3 %~4
if defined HOLDER (
  echo   Port %~3 is already used by !HOLDER!.
  call :free_port %~3 %~4
  echo   Suggesting !FREE_PORT! instead.
)
:ask_port_again
call :ask %~1 "%~2" "!FREE_PORT!"
set "PORT_NUM="
set /a PORT_NUM=!%~1! 2>nul
if not "!PORT_NUM!"=="!%~1!" goto :ask_port_bad
if !PORT_NUM! lss 1 goto :ask_port_bad
if !PORT_NUM! gtr 65535 goto :ask_port_bad
call :port_holder !%~1! %~4
if not defined HOLDER exit /b 0
echo   Port !%~1! is already used by !HOLDER!.
call :free_port !%~1! %~4
goto :ask_port_again
:ask_port_bad
echo   Enter a port number from 1 to 65535.
goto :ask_port_again

rem :ensure_port VAR own  -> if port !VAR! is taken by anything but our own container, name
rem the holder, ask for another port (a free one suggested), save it and check again.
:ensure_port
set "PORT_NOW=!%~1!"
call :port_holder !PORT_NOW! %~2
if not defined HOLDER exit /b 0
echo.
echo Port !PORT_NOW! on this PC is already used by !HOLDER!.
call :free_port !PORT_NOW! %~2
call :ask NEW_PORT "Port to use instead" "!FREE_PORT!"
call :setenv %~1 "!NEW_PORT!" || exit /b 1
goto :ensure_port

rem :wait_health url  -> polls for up to 5 minutes, prints the answer
:wait_health
echo Waiting for %~1 ...
for /l %%i in (1,1,60) do (
  curl.exe -fsS "%~1" >nul 2>&1 && (
    curl.exe -s "%~1"
    echo.
    exit /b 0
  )
  timeout /t 5 /nobreak >nul
)
echo No answer after 5 minutes. See what the server says with:
echo   %DC% logs app
exit /b 1

rem :run_step "command"  -> a step with a Try again / Skip / Quit menu when it fails.
:run_step
%~1
if not errorlevel 1 exit /b 0
echo.
echo That step failed, see the message above.
choice /c TSQ /n /m "[T]ry again, [S]kip or [Q]uit: "
if errorlevel 3 exit /b 1
if errorlevel 2 exit /b 0
goto :run_step

rem :firewall  -> offers an inbound Windows Firewall rule for APP_PORT, so PCs on the LAN get in.
:firewall
netsh advfirewall firewall show rule name=PC_READER-%APP_PORT% >nul 2>&1 && exit /b 0
echo.
echo PCs on the network need port %APP_PORT% open in Windows Firewall.
choice /c YN /m "Add the rule PC_READER-%APP_PORT% now (Windows asks for Administrator)"
if errorlevel 2 (
  echo Skipped. To add it later, in an Administrator prompt:
  echo   netsh advfirewall firewall add rule name=PC_READER-%APP_PORT% dir=in action=allow protocol=TCP localport=%APP_PORT% profile=domain,private
  exit /b 0
)
powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=PC_READER-%APP_PORT% dir=in action=allow protocol=TCP localport=%APP_PORT% profile=domain,private'" >nul 2>&1
netsh advfirewall firewall show rule name=PC_READER-%APP_PORT% >nul 2>&1 && (
  echo Added the firewall rule PC_READER-%APP_PORT% ^(domain and private networks^).
  exit /b 0
)
echo The rule was not added. In an Administrator prompt:
echo   netsh advfirewall firewall add rule name=PC_READER-%APP_PORT% dir=in action=allow protocol=TCP localport=%APP_PORT% profile=domain,private
exit /b 0

:tunnel_help
echo.
echo Cloudflare: Zero Trust - Networks - Tunnels - Create a tunnel - Cloudflared - Docker.
echo Copy only the long token after "--token ".
echo Then add a public hostname: your address, Service HTTP, URL app:3000 ^(not localhost^).
echo.
exit /b 0

rem :ask_tunnel  -> optional Cloudflare Tunnel; writes its settings into %ENVFILE%
:ask_tunnel
echo An https address through Cloudflare lets PCs outside the office reach the server.
echo The dashboard has no login yet, so it then needs Cloudflare Access in front.
choice /c YN /m "Add a Cloudflare Tunnel"
if errorlevel 2 exit /b 0
call :tunnel_help
:ask_tunnel_url
call :ask_required TUNNEL_URL "Public address, e.g. https://pcreader.example.gov.ph"
if "!TUNNEL_URL:~-1!"=="/" set "TUNNEL_URL=!TUNNEL_URL:~0,-1!"
if /i not "!TUNNEL_URL:~0,8!"=="https://" (
  echo   It must start with https://
  goto :ask_tunnel_url
)
call :ask_required TUNNEL_TOKEN "Tunnel token, saved only in %ENVFILE%"
call :setenv PUBLIC_URL "!TUNNEL_URL!" || exit /b 1
call :setenv CLOUDFLARE_TUNNEL_TOKEN "!TUNNEL_TOKEN!" || exit /b 1
set "TUNNEL_TOKEN="
cls
echo Saved the tunnel settings ^(screen cleared so the token is not left on it^).
exit /b 0
