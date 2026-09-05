[CmdletBinding(DefaultParameterSetName = 'Load')]
param(
    [Parameter(ParameterSetName = 'Load')][switch]$Load,
    [Parameter(Mandatory, ParameterSetName = 'Save')][string]$PacketJson,
    [Parameter(Mandatory, ParameterSetName = 'Progress')][string]$ProgressJson
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
if ($PSCmdlet.ParameterSetName -eq 'Load') {
    $waiter = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'wait-for-chat.js'), $utf8)
    $receiver = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'receive-chat.js'), $utf8)
    [pscustomobject]@{waiter=$waiter; waiterChars=$waiter.Length; receiver=$receiver; receiverChars=$receiver.Length} | ConvertTo-Json -Compress
    exit 0
}
$created = [System.Collections.Generic.List[string]]::new()
try {
    $isProgress = $PSCmdlet.ParameterSetName -eq 'Progress'
    $packet = ConvertFrom-Json -InputObject $(if ($isProgress) { $ProgressJson } else { $PacketJson }) -Depth 12
    $required = if ($isProgress) { @('projectRoot', 'outputBase') } else { @('projectRoot', 'outputBase', 'raw', 'delivery') }
    foreach ($name in $required) {
        if ($packet.$name -isnot [string] -or [string]::IsNullOrWhiteSpace($packet.$name)) { throw "Missing text field: $name" }
    }
    if ($packet.projectRoot -notmatch '^[A-Za-z]:[\\/]' -or $packet.outputBase -notmatch '^[A-Za-z]:[\\/]' -or
        $packet.projectRoot -match '[\r\n]' -or $packet.outputBase -match '[\r\n]') { throw 'Absolute Windows file paths required.' }
    $root = [System.IO.Path]::GetFullPath($packet.projectRoot).TrimEnd([char[]]'\/')
    $base = [System.IO.Path]::GetFullPath($packet.outputBase)
    if (-not $base.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Output is outside the chosen project.' }
    if ($base.Substring(2).Contains(':')) { throw 'Alternate data stream paths are not supported.' }
    $parent = [System.IO.Path]::GetDirectoryName($base)
    if (-not (Test-Path -LiteralPath $root -PathType Container) -or -not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Project and output directory must already exist.' }
    $cursor = $parent
    while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Choose an output directory without junctions or symlinks.' }
        if ($cursor.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
        if (-not $cursor) { throw 'Output project boundary could not be verified.' }
    }
    if ($isProgress) {
        if ($packet.status -notmatch '^[a-z_]{1,64}$' -or $packet.chatId -notmatch '^[0-9a-fA-F-]{36}$' -or
            $packet.requestTag -notmatch '^\[WO_REQUEST:[A-Za-z0-9_-]{1,80}\]$') { throw 'Invalid progress identity or status.' }
        $progressPath = $base + '.heartbeat.jsonl'
        if ($packet.start -ne $true) {
            $item = Get-Item -LiteralPath $progressPath -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Progress path is a link.' }
            $reader = [System.IO.StreamReader]::new($progressPath, $utf8)
            try { $first = $reader.ReadLine() | ConvertFrom-Json } finally { $reader.Dispose() }
            if ($first.requestTag -ne $packet.requestTag -or $first.chatId -ne $packet.chatId) { throw 'Progress belongs to another request.' }
        }
        $line = [pscustomobject]@{time=[DateTimeOffset]::UtcNow.ToString('o'); status=$packet.status; requestTag=$packet.requestTag; chatId=$packet.chatId}
        $mode = if ($packet.start -eq $true) { [System.IO.FileMode]::CreateNew } else { [System.IO.FileMode]::Append }
        $stream = [System.IO.FileStream]::new($progressPath, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try { $bytes=$utf8.GetBytes(($line | ConvertTo-Json -Compress) + "`n"); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
        [pscustomobject]@{status='progress_saved'; path=$progressPath} | ConvertTo-Json -Compress
        exit 0
    }
    $rawPath = $base + '.raw.md'
    $bodyPath = $base + '.md'
    $receiptPath = $base + '.receipt.json'
    foreach ($filePath in @($rawPath, $bodyPath, $receiptPath)) {
        if (Test-Path -LiteralPath $filePath) { throw "Existing file will not be overwritten: $filePath" }
    }
    if (-not $packet.receipt) { throw 'Missing receipt.' }
    $packet.receipt | Add-Member -NotePropertyName rawPath -NotePropertyValue $rawPath
    $packet.receipt | Add-Member -NotePropertyName bodyPath -NotePropertyValue $bodyPath
    $files = @(
        @{path=$rawPath; text=$packet.raw},
        @{path=$bodyPath; text=$packet.delivery},
        @{path=$receiptPath; text=($packet.receipt | ConvertTo-Json -Depth 12 -Compress)}
    )
    foreach ($file in $files) {
        $stream = [System.IO.FileStream]::new($file.path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $created.Add($file.path)
        try { $bytes = $utf8.GetBytes($file.text); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    [pscustomobject]@{status='saved'; rawPath=$rawPath; bodyPath=$bodyPath; receiptPath=$receiptPath} | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{status='save_error'; created=@($created); error=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
