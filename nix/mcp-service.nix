# NixOS module: breeze-tts-mcp as a streamable-http systemd service.
#
# Usage:
#   imports = [ github:...  breeze-tts-mcp ];
#   services.breeze-tts-mcp = {
#     enable = true;
#     breezeServerUrl = "http://127.0.0.1:1923";
#   };
#
# MCP stdio servers are spawned per client session, so they cannot be long
# running units; this serves the streamable HTTP transport instead and any
# MCP host connects over http://HOST:PORT/mcp.

self:
{ lib, config, pkgs, ... }:
let
	cfg = config.services.breeze-tts-mcp;

	# the desktop session's uid, so playback can reach its sound server
	sessionUid =
		if cfg.user == null then null
		else
			let
				uid = config.users.users."${cfg.user}".uid;
			in
			if uid == null then
				throw "services.breeze-tts-mcp: user ${cfg.user} has no static uid"
			else toString uid;

	# systemd manages StateDirectory= entries only under /var/lib; anywhere
	# else the operator owns the directory
	stateSubdir = lib.removePrefix "/var/lib/" cfg.stateDir;
	stateManaged = stateSubdir != cfg.stateDir;
in
{
	options.services.breeze-tts-mcp = {
		enable = lib.mkEnableOption "the breeze-tts-mcp speech server";

		package = lib.mkOption {
			type = lib.types.package;
			default = self.packages.${pkgs.system}.breeze-tts-mcp;
			defaultText = "breeze-tts-mcp.packages.<system>.breeze-tts-mcp";
			description = "The breeze-tts-mcp derivation.";
		};

		stateDir = lib.mkOption {
			type = lib.types.str;
			default = "/var/lib/breeze-tts-mcp";
			description = "State directory, used while keepGenerations is on: generated WAVs are written to it. Under /var/lib systemd creates and keeps the directory; anywhere else the operator owns it. With keepGenerations false the clips go to /run/breeze-tts-mcp (tmpfs) instead and this option is unused.";
		};

		host = lib.mkOption {
			type = lib.types.str;
			default = "127.0.0.1";
			description = "Interface to bind the MCP http listener to.";
		};

		port = lib.mkOption {
			type = lib.types.port;
			default = 8123;
			description = "Port for the streamable HTTP MCP transport at /mcp.";
		};

		breezeServerUrl = lib.mkOption {
			type = lib.types.str;
			default = "http://127.0.0.1:1923";
			description = "Base URL of the Breeze-TTS-2.cpp server this toolset talks to.";
		};

		user = lib.mkOption {
			type = lib.types.nullOr lib.types.str;
			default = null;
			description = "Run the service as this user. Set it to the desktop session user so generated audio can reach that session's sound server (PipeWire/PulseAudio through /run/user/<uid>) — a root-run service has no audio session and playback fails silently. Playback also requires that user to be logged in, so the unit starts before a session and still serves tools fine.";
		};

		# The speaking tools play through a player probed from PATH
		playerPackage = lib.mkOption {
			type = lib.types.nullOr lib.types.package;
			default = pkgs.ffmpeg; # supplies ffplay
			defaultText = "pkgs.ffmpeg";
			description = "Audio player package that ends up in the service PATH (ffplay is probed first). Set to null and manage PATH yourself.";
		};

		enablePlayback = lib.mkOption {
			type = lib.types.bool;
			default = true;
			description = "Whether generated audio actually plays through the speakers. With false, the server is muted (handy for a headless second instance).";
		};

		keepGenerations = lib.mkOption {
			type = lib.types.bool;
			default = true;
			description = "Whether generated WAVs persist, written into stateDir. With false they are written to /run/breeze-tts-mcp (tmpfs) instead: wiped at reboot, recreated at every activation — for machines where clips are throwaway.";
		};
	};

	config = lib.mkIf cfg.enable {
		systemd.services.breeze-tts-mcp = {
			description = "breeze-tts-mcp: Breeze voice toolkit over MCP";
			wantedBy = [ "multi-user.target" ];
			after = [ "network.target" ];

			# Composed ONTO the systemd default PATH (coreutils, which's lookup
			# path, ...) — never a plain environment.PATH, which collides with
			# the systemd module's own definition. `which` matters: the player
			# probe shells out to it.
			path = [ pkgs.which ] ++ lib.optionals (cfg.playerPackage != null) [ cfg.playerPackage ];

			environment = {
				BREEZE_TTS_URL = cfg.breezeServerUrl;
				BREEZE_TTS_WORK_DIR =
					if cfg.keepGenerations
					then cfg.stateDir
					else "/run/breeze-tts-mcp";
				BREEZE_TTS_PLAYER = if cfg.enablePlayback then "" else "/bin/true";
				XDG_RUNTIME_DIR = lib.mkIf (sessionUid != null) "/run/user/${sessionUid}";
			};

			serviceConfig = {
				Type = "simple";
				ExecStart = "${lib.getExe cfg.package} --http ${toString cfg.port} --host ${cfg.host}";
				StateDirectory = lib.mkIf (cfg.keepGenerations && stateManaged) stateSubdir;
				RuntimeDirectory = lib.mkIf (!cfg.keepGenerations) "breeze-tts-mcp";
				User = lib.mkIf (cfg.user != null) cfg.user;
				Restart = "on-failure";
				RestartSec = 5;
			};
		};
	};
}