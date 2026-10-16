{
	description = "MCP server giving any agent the Breeze-TTS-2.cpp voice toolkit";

	inputs = {
		nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
		flake-utils.url = "github:numtide/flake-utils";
	};

	outputs = { self, nixpkgs, flake-utils, ... }:
		{
			# The MCP server itself, as a streamable-http systemd service.
			nixosModules.breeze-tts-mcp = import ./nix/mcp-service.nix self;
			nixosModules.default = self.nixosModules.breeze-tts-mcp;
		}
		// flake-utils.lib.eachDefaultSystem (system:
			let
				pkgs = import nixpkgs { inherit system; };
				lib = pkgs.lib;

				breeze-tts-mcp = pkgs.buildNpmPackage {
					pname = "breeze-tts-mcp";
					version = "1.0.0";
					src = self;

					# The npm build = the bare script name (nixpkgs' npmBuildScript);
					# the bundles are self-contained (sdk + zod inlined), so the store
					# runtime needs only node and the audio player
					npmBuildScript = "bundle";
					dontNpmInstall = true;
					npmDepsHash = "sha256-x1j7ZInSyWtUBojQnLASxXkQiOPnW8JepAPfa7yLMV8=";
					nativeBuildInputs = [ pkgs.makeWrapper ];

					postInstall = ''
						mkdir -p $out/libexec
						cp -r dist $out/libexec/dist
						cp -r skill $out/libexec/skill

						mkdir -p $out/bin
						makeWrapper ${pkgs.nodejs}/bin/node $out/bin/breeze-tts-mcp \
							--add-flags "$out/libexec/dist/src/server.bundle.mjs"
						makeWrapper ${pkgs.nodejs}/bin/node $out/bin/breeze-speak \
							--add-flags "$out/libexec/dist/src/cli.bundle.mjs"
					'';

					meta = {
						description = "MCP server exposing Breeze-TTS-2.cpp: speak with voice direction, design voices, manage the voice library";
						license = lib.licenses.asl20;
						mainProgram = "breeze-tts-mcp";
						platforms = lib.platforms.linux;
					};
				};
			in
			{
				packages.breeze-tts-mcp = breeze-tts-mcp;
				packages.default = breeze-tts-mcp;

				devShells.default = pkgs.mkShell {
					packages = with pkgs; [ nodejs ffmpeg ];
					shellHook = ''
						if [ ! -d node_modules ]; then
							echo "Installing node_modules..."
							npm install
						fi
					'';
				};
			});
}