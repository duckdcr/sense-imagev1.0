param(
  [int]$Port = 3456,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerPath = Join-Path $Root "server.js"
$RuntimeNode = Join-Path $Root "runtime\node.exe"
$LogsDir = Join-Path $Root "logs"

function Get-NodePath {
  if (Test-Path -LiteralPath $RuntimeNode) {
    return $RuntimeNode
  }

  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($NodeCommand) {
    return $NodeCommand.Source
  }

  throw "Node.js not found. Keep runtime\node.exe in this folder."
}

function Get-FreePort([int]$StartPort) {
  for ($Candidate = $StartPort; $Candidate -le ($StartPort + 99); $Candidate += 1) {
    $Busy = Get-NetTCPConnection -LocalPort $Candidate -State Listen -ErrorAction SilentlyContinue
    if ($Busy) {
      continue
    }

    $Listener = $null
    try {
      $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Candidate)
      $Listener.Start()
      return $Candidate
    } catch {
      continue
    } finally {
      if ($Listener) {
        $Listener.Stop()
      }
    }
  }

  throw "No free local port found."
}

function Wait-ForReady([string]$Url, [System.Diagnostics.Process]$Process) {
  for ($Index = 0; $Index -lt 80; $Index += 1) {
    if ($Process.HasExited) {
      throw "Server exited early. Check logs\server.err.log."
    }

    try {
      $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1
      if ($Response.StatusCode -eq 200) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "Server did not become ready. Check logs\server.err.log."
}

function Start-Tool {
if (!(Test-Path -LiteralPath $ServerPath)) {
  throw "server.js not found."
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$NodePath = Get-NodePath
$ChosenPort = Get-FreePort $Port
$Url = "http://127.0.0.1:$ChosenPort/"
$env:PORT = [string]$ChosenPort

$StdoutPath = Join-Path $LogsDir "server.log"
$StderrPath = Join-Path $LogsDir "server.err.log"
$ServerProcess = $null

try {
  $ServerProcess = Start-Process `
    -FilePath $NodePath `
    -ArgumentList "`"$ServerPath`"" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru

  Wait-ForReady -Url $Url -Process $ServerProcess

  if ($NoOpen) {
    Write-Output "READY $Url"
    return
  }

  try {
    Start-Process $Url
  } catch {
    Write-Warning "Browser did not open automatically. Open $Url manually."
  }
  Write-Host ""
  Write-Host "Batch image tool is running:"
  Write-Host $Url
  Write-Host ""
  Read-Host "Press Enter here to stop the server"
} finally {
  if ($ServerProcess -and !$ServerProcess.HasExited) {
    Stop-Process -Id $ServerProcess.Id -Force
  }
}
}

try {
  Start-Tool
} catch {
  Write-Host ""
  Write-Host "Startup failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Check logs\server.err.log for details." -ForegroundColor Yellow
  exit 1
}
