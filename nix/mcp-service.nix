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
	};

	config = lib.mkIf cfg.enable {
		systemd.services.breeze-tts-mcp = {
			description = "breeze-tts-mcp: Breeze voice toolkit over MCP";
			wantedBy = [ "multi-user.target" ];
			after = [ "network.target" ];

			environment = {
				BREEZE_TTS_URL = cfg.breezeServerUrl;
				BREEZE_TTS_WORK_DIR = "/var/lib/breeze-tts-mcp";
				BREEZE_TTS_PLAYER = if cfg.enablePlayback then "" else "/bin/true";
				PATH = "${lib.makeBinPath (lib.optional (cfg.playerPackage != null) cfg.playerPackage)}";
			};

			serviceConfig = {
				Type = "simple";
				ExecStart = "${lib.getExe cfg.package} --http ${toString cfg.port} --host ${cfg.host}";
				StateDirectory = "breeze-tts-mcp";
				Restart = "on-failure";
				RestartSec = 5;
			};
		};
	};
}