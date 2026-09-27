# Login shells reset PATH before loading /etc/profile.d.
# Keep provider CLIs installed on the persistent home volume available.
export PATH="$HOME/.local/bin:$PATH"
