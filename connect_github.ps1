# Create a git repository if it doesn't exist
if (-not (Test-Path .git)) {
    Write-Host "Initializing git repository..."
    git init
}

# Add remote if not already added
$remotes = git remote
if ($remotes -notcontains "origin") {
    Write-Host "Adding remote origin..."
    git remote add origin https://github.com/nikhilvirdi/stenod
} else {
    Write-Host "Remote origin already exists. Updating URL..."
    git remote set-url origin https://github.com/nikhilvirdi/stenod
}

# Fetch the remote repository
Write-Host "Fetching from remote..."
git fetch origin

# Set default branch name to main
git branch -M main

# Track or pull from origin main
Write-Host "Checking remote branches..."
$remoteBranches = git branch -r
if ($remoteBranches -like "*origin/main*") {
    Write-Host "Remote 'main' branch found. Pulling changes..."
    git pull origin main --rebase --allow-unrelated-histories
} else {
    Write-Host "Remote 'main' branch not found. Creating local main and preparing first push..."
    git add .
    git commit -m "docs: add README and SSOT spec"
    Write-Host "To push your changes to GitHub, run: git push -u origin main"
}

Write-Host "Done!"
