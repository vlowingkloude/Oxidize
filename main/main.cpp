#include <atomic>
#include <charconv>
#include <csignal>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

import server;
import files;

#ifndef OXIDIZE_DEFAULT_STATIC_DIRECTORY
#define OXIDIZE_DEFAULT_STATIC_DIRECTORY "frontend/dist"
#endif

namespace {
    struct Config {
        std::filesystem::path path;
        std::string host{"127.0.0.1"};
        std::uint16_t port{1377};
        std::filesystem::path static_directory{OXIDIZE_DEFAULT_STATIC_DIRECTORY};
    };

    std::atomic_bool stopping{false};

    void stop(int) {
        stopping.store(true, std::memory_order_relaxed);
    }

    void print_usage() {
        std::cerr << "Usage: oxidize [PATH] [--host HOST] [--port PORT] [--static-dir DIR]\n";
    }

    Config parse_arguments(int argc, char **argv) {
        Config result;
        for (int index = 1; index < argc; ++index) {
            std::string argument(argv[index]);
            const auto equals = argument.find('=');
            const auto name = argument.substr(0, equals);
            const bool inline_value = equals != std::string::npos;
            auto value = inline_value ? argument.substr(equals + 1) : std::string{};
            if (name == "-h" || name == "--help") {
                print_usage();
                std::exit(0);
            }
            if (name == "--host" || name == "--port" || name == "--static-dir") {
                if (!inline_value) {
                    if (++index >= argc) throw std::runtime_error(name + " requires a value");
                    value = argv[index];
                }
                if (name == "--host") {
                    if (value.find_first_not_of(" \t\r\n") == std::string::npos) throw std::runtime_error(
                        "--host cannot be empty");
                    result.host = value;
                } else if (name == "--static-dir") {
                    if (value.find_first_not_of(" \t\r\n") == std::string::npos) throw std::runtime_error(
                        "--static-dir cannot be empty");
                    result.static_directory = value;
                } else {
                    unsigned int parsed = 0;
                    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
                    if (error != std::errc{} || end != value.data() + value.size() || parsed == 0 || parsed > 65535) {
                        throw std::runtime_error("invalid port: " + value);
                    }
                    result.port = static_cast<std::uint16_t>(parsed);
                }
                continue;
            }
            if (!argument.empty() && argument.front() == '-') throw std::runtime_error("unknown option: " + argument);
            if (!result.path.empty()) throw std::runtime_error("only one workspace path can be opened");
            result.path = argument;
        }
        return result;
    }
}

int main(int argc, char **argv) {
    try {
        const auto configuration = parse_arguments(argc, argv);
        std::optional<oxidize::files::WorkspaceInfo> initial_workspace;
        if (!configuration.path.empty()) initial_workspace = oxidize::files::open_workspace(configuration.path);
        std::signal(SIGINT, stop);
        std::signal(SIGTERM, stop);
        std::signal(SIGPIPE, SIG_IGN);
        std::clog << "Oxidize is available at " << configuration.host << ':' << configuration.port << '\n';
        oxidize::server::Server server(std::move(initial_workspace), configuration.static_directory);
        server.run(configuration.host, configuration.port, stopping);
        return 0;
    } catch (const std::exception &caught) {
        std::cerr << caught.what() << '\n';
        print_usage();
        return 2;
    }
}
