module;

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <utility>

export module server;

import lsp;
import json;
import terminal;
import watcher;
import files;
import boost_wrapper;

export namespace oxidize::server {

    class Server {
    public:
        Server(std::optional<files::WorkspaceInfo> initial_workspace, std::filesystem::path static_directory);
        void run(const std::string& host, std::uint16_t port, const std::atomic_bool& stopping);

    private:
        std::optional<files::WorkspaceInfo> initial_workspace_;
        std::filesystem::path static_directory_;
    };

}

namespace oxidize::server {

    class RequestError final : public std::runtime_error {
    public:
        using std::runtime_error::runtime_error;
    };

    struct Target {
        std::string path;
        std::map<std::string, std::string> query;
    };

    namespace asio = boost_wrapper::asio;
    namespace beast = boost_wrapper::beast;
    namespace http = beast::http;
    namespace websocket = beast::websocket;

    using tcp = asio::ip::tcp;
    using Request = boost_wrapper::HttpRequest;
    using Response = boost_wrapper::HttpResponse;

}

namespace oxidize::server {

    std::string trim(std::string value) {
        const auto whitespace = [](const unsigned char character) {
            return std::isspace(character) != 0;
        };
        value.erase(value.begin(), std::ranges::find_if_not(value.begin(), value.end(), whitespace));
        value.erase(std::find_if_not(value.rbegin(), value.rend(), whitespace).base(), value.end());
        return value;
    }

    int hex_value(char character) {
        if (character >= '0' && character <= '9') return character - '0';
        if (character >= 'a' && character <= 'f') return character - 'a' + 10;
        if (character >= 'A' && character <= 'F') return character - 'A' + 10;
        return -1;
    }

    std::string url_decode(std::string_view input) {
        std::string result;
        result.reserve(input.size());
        for (std::size_t index = 0; index < input.size(); ++index) {
            if (input[index] == '+') {
                result.push_back(' ');
            } else if (input[index] == '%' && index + 2 < input.size()) {
                const int high = hex_value(input[index + 1]);
                const int low = hex_value(input[index + 2]);
                if (high < 0 || low < 0) {
                    throw RequestError("invalid URL encoding");
                }
                result.push_back(static_cast<char>((high << 4) | low));
                index += 2;
            } else if (input[index] == '%') {
                throw RequestError("invalid URL encoding");
            } else {
                result.push_back(input[index]);
            }
        }
        return result;
    }

    Target parse_target(const std::string_view raw_target) {
        const std::string target(raw_target);
        const auto question = target.find('?');
        Target result{url_decode(target.substr(0, question)), {}};
        if (question == std::string::npos) {
            return result;
        }
        std::size_t start = question + 1;
        while (start <= target.size()) {
            const auto end = target.find('&', start);
            const auto item = std::string_view(target).substr(start, end == std::string::npos ? std::string::npos : end - start);
            const auto equals = item.find('=');
            const auto name = url_decode(item.substr(0, equals));
            const auto value = equals == std::string_view::npos ? std::string{} : url_decode(item.substr(equals + 1));
            result.query[name] = value;
            if (end == std::string::npos) {
                break;
            }
            start = end + 1;
        }
        return result;
    }

    files::WorkspaceInfo workspace_from_parts(const std::string& root, const std::optional<std::string>& initial_file) {
        if (root.empty()) {
            throw RequestError("workspace root is required");
        }
        return files::open_workspace(initial_file ?
            std::filesystem::path(root) / *initial_file : std::filesystem::path(root));
    }

    files::WorkspaceInfo workspace_from_query(const Target& target) {
        const auto root = target.query.find("root");
        std::optional<std::string> initial_file;
        if (const auto found = target.query.find("initial_file"); found != target.query.end() && !found->second.empty()) {
            initial_file = found->second;
        }
        return workspace_from_parts(root == target.query.end() ? "" : root->second, initial_file);
    }

    json::json_type decode_json(const Request& request, std::initializer_list<std::string_view> allowed) {
        json::json_type value;
        try {
            value = json::json_type::parse(request.body());
        } catch (const std::exception& caught) {
            throw RequestError(std::string("invalid JSON request: ") + caught.what());
        }
        if (!value.is_object()) {
            throw RequestError("invalid JSON request: expected an object");
        }
        const std::unordered_set<std::string_view> fields(allowed);
        return value;
    }

    std::string required_string(const json::json_type& value, const char* name) {
        const auto found = value.find(name);
        if (found == value.end() || !found->is_string()) {
            throw RequestError(std::string("invalid JSON request: ") + name + " must be a string");
        }
        return found->get<std::string>();
    }

    std::optional<std::string> optional_string(const json::json_type& value, const char* name) {
        const auto found = value.find(name);
        if (found == value.end() || found->is_null()) {
            return std::nullopt;
        }
        if (!found->is_string()) {
            throw RequestError(std::string("invalid JSON request: ") + name + " must be a string or null");
        }
        return found->get<std::string>();
    }

    files::WorkspaceInfo workspace_from_json(const json::json_type& value) {
        return workspace_from_parts(required_string(value, "root"), optional_string(value, "initial_file"));
    }

    void decorate(Response& response) {
        response.set(http::field::server, "Oxidize");
        response.set(http::field::access_control_allow_origin, "*");
        response.set(http::field::access_control_allow_headers, "Content-Type");
        response.set(http::field::access_control_allow_methods, "GET, POST, OPTIONS");
    }

    Response text_response(const Request& request, http::status status, std::string body, std::string_view content_type) {
        Response response{status, request.version()};
        response.keep_alive(request.keep_alive());
        decorate(response);
        response.set(http::field::content_type, content_type);
        response.body() = std::move(body);
        response.prepare_payload();
        return response;
    }

    Response json_response(const Request& request, http::status status, const json::json_type& value) {
        return text_response(request, status, value.dump() + "\n", "application/json; charset=utf-8");
    }

    Response empty_response(const Request& request, http::status status = http::status::no_content) {
        Response response{status, request.version()};
        response.keep_alive(request.keep_alive());
        decorate(response);
        response.prepare_payload();
        return response;
    }

    Response error_response(const Request& request, const std::exception& error) {
        auto status = http::status::internal_server_error;
        if (dynamic_cast<const RequestError*>(&error) != nullptr) {
            status = http::status::bad_request;
        }
        if (const auto* system = dynamic_cast<const std::system_error*>(&error)) {
            if (system->code() == std::errc::no_such_file_or_directory) {
                status = http::status::not_found;
            }
        }
        json::json_type err = {{"error", error.what()}};
        return json_response(request, status, err);
    }

    Response require_method(const Request& request, http::verb expected) {
        json::json_type err = {{"error", "method not allowed"}};
        auto response = json_response(request, http::status::method_not_allowed, err);
        response.set(http::field::allow, boost_wrapper::http_verb_string(expected));
        return response;
    }

    std::string mime_type(const std::filesystem::path& path) {
        auto extension = path.extension().string();
        std::ranges::transform(extension, extension.begin(), [](const unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        if (extension == ".htm" || extension == ".html") return "text/html; charset=utf-8";
        if (extension == ".css") return "text/css; charset=utf-8";
        if (extension == ".js" || extension == ".mjs") return "text/javascript; charset=utf-8";
        if (extension == ".json" || extension == ".map") return "application/json; charset=utf-8";
        if (extension == ".svg") return "image/svg+xml";
        if (extension == ".png") return "image/png";
        if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
        if (extension == ".gif") return "image/gif";
        if (extension == ".webp") return "image/webp";
        if (extension == ".bmp") return "image/bmp";
        if (extension == ".ico") return "image/x-icon";
        if (extension == ".avif") return "image/avif";
        if (extension == ".woff") return "font/woff";
        if (extension == ".woff2") return "font/woff2";
        if (extension == ".wasm") return "application/wasm";
        return "application/octet-stream";
    }

    std::string read_file(const std::filesystem::path& path) {
        std::ifstream input(path, std::ios::binary);
        if (!input) {
            throw std::runtime_error("failed to open file: " + path.string());
        }
        return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    }

    Response static_response(const Request& request, const Target& target, const std::filesystem::path& static_directory) {
        auto relative = std::filesystem::path(target.path.empty() ? "/" : target.path).lexically_normal().relative_path();
        auto path = static_directory / relative;
        std::error_code error;
        if (std::filesystem::is_directory(path, error)) {
            path /= "index.html";
        }
        if (!error && std::filesystem::is_regular_file(path, error)) {
            return text_response(request, http::status::ok, read_file(path), mime_type(path));
        }
        const auto index = static_directory / "index.html";
        if (!std::filesystem::is_regular_file(index, error)) {
            throw std::runtime_error("frontend build not found in " + static_directory.string());
        }
        return text_response(request, http::status::ok, read_file(index), mime_type(index));
    }

    Response handle_api(const Request &request, const Target &target,
                        const std::optional<files::WorkspaceInfo> &initial_workspace,
                        const std::filesystem::path &static_directory) {
        if (request.method() == http::verb::options) {
            return empty_response(request);
        }
        if (target.path == "/api/health") {
            if (request.method() != http::verb::get) {
                return require_method(request, http::verb::get);
            }
            json::json_type v = {{"ok", true}};
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/workspace") {
            if (request.method() != http::verb::get) {
                return require_method(request, http::verb::get);
            }
            json::json_type v = initial_workspace.has_value() ?
                                    json::json_type(initial_workspace.value()) : json::json_type(nullptr);
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/workspace/open") {
            if (request.method() != http::verb::post) {
                return require_method(request, http::verb::post);
            }
            const auto body = decode_json(request, {"path"});
            const auto path = trim(required_string(body, "path"));
            if (path.empty()) {
                throw RequestError("a path is required");
            }
            json::json_type v = files::open_workspace(path);
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/tree") {
            if (request.method() != http::verb::get) {
                return require_method(request, http::verb::get);
            }
            const auto directory = target.query.find("path");
            json::json_type v = files::list_tree(
                workspace_from_query(target), directory == target.query.end() ? "" : directory->second);
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/files") {
            if (request.method() != http::verb::get) {
                return require_method(request, http::verb::get);
            }
            json::json_type v = files::list_workspace_files(workspace_from_query(target));
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/file/read" || target.path == "/api/file/write" ||
            target.path == "/api/file/create" || target.path == "/api/file/rename" ||
            target.path == "/api/file/delete") {
            if (request.method() != http::verb::post) {
                return require_method(request, http::verb::post);
            }
            auto allowed = std::initializer_list<std::string_view>{"root", "initial_file", "path"};
            json::json_type body;
            if (target.path == "/api/file/write") body = decode_json(request, {
                                                                         "root", "initial_file", "path", "content"
                                                                     });
            else if (target.path == "/api/file/create") body = decode_json(request, {
                                                                               "root", "initial_file", "path", "kind"
                                                                           });
            else if (target.path == "/api/file/rename") body = decode_json(request, {
                                                                               "root", "initial_file", "path",
                                                                               "destination"
                                                                           });
            else body = decode_json(request, allowed);
            const auto workspace = workspace_from_json(body);
            const auto path = required_string(body, "path");
            if (target.path == "/api/file/read") {
                json::json_type v = files::read_text_file(workspace, path);
                return json_response(request, http::status::ok, v);
            }
            if (target.path == "/api/file/write") {
                json::json_type v = files::write_text_file(workspace, path, required_string(body, "content"));
                return json_response(request, http::status::ok, v);
            }
            if (target.path == "/api/file/create") {
                files::create_entry(workspace, path, required_string(body, "kind"));
            } else if (target.path == "/api/file/rename") {
                files::rename_entry(workspace, path, required_string(body, "destination"));
            } else {
                files::delete_entry(workspace, path);
            }
            return empty_response(request);
        }
        if (target.path == "/api/search") {
            if (request.method() != http::verb::post) {
                return require_method(request, http::verb::post);
            }
            const auto body = decode_json(request, {"root", "initial_file", "query", "case_sensitive"});
            const auto workspace = workspace_from_json(body);
            const auto query = trim(required_string(body, "query"));
            bool case_sensitive = false;
            if (const auto found = body.find("case_sensitive"); found != body.end()) {
                if (!found->is_boolean()) {
                    throw RequestError("invalid JSON request: case_sensitive must be a boolean");
                }
                case_sensitive = found->get<bool>();
            }
            json::json_type v = files::search_workspace(workspace, query, case_sensitive);
            return json_response(request, http::status::ok, v);
        }
        if (target.path == "/api/file/raw") {
            if (request.method() != http::verb::get) {
                return require_method(request, http::verb::get);
            }
            const auto path_value = target.query.find("path");
            const auto path = files::raw_file_path(workspace_from_query(target),
                                                   path_value == target.query.end() ? "" : path_value->second);
            const auto content_type = mime_type(path);
            if (!content_type.starts_with("image/")) {
                throw RequestError("raw preview is limited to image files");
            }
            return text_response(request, http::status::ok, read_file(path), content_type);
        }
        if (target.path.starts_with("/api/")) {
            json::json_type v = {{"error", "API route not found"}};
            return json_response(request, http::status::not_found, v);
        }
        if (request.method() != http::verb::get) {
            return require_method(request, http::verb::get);
        }
        return static_response(request, target, static_directory);
    }

    void run_websocket(beast::tcp_stream stream, const Request &request, const Target &target,
                       const files::WorkspaceInfo &workspace,
                       const std::optional<lsp::LanguageServer> &language_server) {
        auto socket = boost_wrapper::make_websocket(std::move(stream));
        boost_wrapper::configure_websocket(socket, 16U << 20U);
        boost_wrapper::accept_websocket(socket, request);
        if (target.path == "/api/watch") {
            watcher::run(socket, workspace);
        } else if (target.path == "/api/terminal") {
            terminal::run(socket, workspace.root);
        } else if (target.path == "/api/lsp") {
            lsp::run(socket, workspace.root, language_server.value());
        } else {
            throw RequestError("API route not found");
        }
    }

    void handle_session(tcp::socket socket, std::optional<files::WorkspaceInfo> initial_workspace,
                        std::filesystem::path static_directory) {
        try {
            beast::tcp_stream stream(std::move(socket));
            beast::flat_buffer buffer;
            while (true) {
                stream.expires_after(std::chrono::seconds(10));
                boost_wrapper::HttpRequestParser parser;
                parser.body_limit(8U << 20U);
                boost_wrapper::error_code error;
                boost_wrapper::read_http(stream, buffer, parser, error);
                if (error == http::error::end_of_stream) {
                    break;
                }
                if (error) {
                    throw boost_wrapper::system_error(error);
                }
                auto request = parser.release();
                const auto request_target = boost_wrapper::http_target_string(request);
                const auto target = parse_target(request_target);
                std::clog << boost_wrapper::http_verb_string(request.method()) << ' ' << request_target << '\n';
                if (boost_wrapper::is_websocket_upgrade(request) &&
                    (target.path == "/api/watch" || target.path == "/api/terminal" || target.path == "/api/lsp")) {
                    std::optional<files::WorkspaceInfo> workspace;
                    std::optional<lsp::LanguageServer> language_server;
                    try {
                        workspace = workspace_from_query(target);
                        if (target.path == "/api/lsp") {
                            const auto language = target.query.find("language");
                            const auto name = language == target.query.end() ? std::string{} : language->second;
                            language_server = lsp::language_server_for(name);
                            if (!language_server) {
                                throw RequestError("unsupported language server: " + name);
                            }
                        }
                    } catch (const std::exception &caught) {
                        const auto response = error_response(request, caught);
                        boost_wrapper::write_http(stream, response);
                        return;
                    }
                    run_websocket(std::move(stream), request, target, workspace.value(), language_server);
                    return;
                }
                Response response;
                try {
                    response = handle_api(request, target, initial_workspace, static_directory);
                } catch (const std::exception &caught) {
                    response = error_response(request, caught);
                }
                const bool keep_alive = response.keep_alive();
                boost_wrapper::write_http(stream, response);
                if (!keep_alive) {
                    break;
                }
            }
            boost_wrapper::error_code ignored;
            ignored = stream.socket().shutdown(tcp::socket::shutdown_send, ignored);
        } catch (const boost_wrapper::system_error &caught) {
            if (caught.code() != websocket::error::closed && caught.code() != asio::error::eof &&
                caught.code() != asio::error::connection_reset) {
                std::clog << "connection failed: " << caught.what() << '\n';
            }
        } catch (const std::exception &caught) {
            std::clog << "connection failed: " << caught.what() << '\n';
        }
    }

}

export namespace oxidize::server {

    Server::Server(std::optional<files::WorkspaceInfo> initial_workspace,
                   std::filesystem::path static_directory)
        : initial_workspace_(std::move(initial_workspace)), static_directory_(std::move(static_directory)) {
    }

    void Server::run(const std::string &host, const std::uint16_t port, const std::atomic_bool &stopping) {
        asio::io_context context(1);
        tcp::resolver resolver(context);
        const auto endpoints = resolver.resolve(host, std::to_string(port), tcp::resolver::passive);
        if (endpoints.empty()) {
            throw std::runtime_error("failed to resolve listen address: " + host);
        }
        tcp::acceptor acceptor(context);
        acceptor.open(endpoints.begin()->endpoint().protocol());
        acceptor.set_option(asio::socket_base::reuse_address(true));
        acceptor.bind(endpoints.begin()->endpoint());
        acceptor.listen(asio::socket_base::max_listen_connections);
        acceptor.non_blocking(true);
        while (!stopping.load(std::memory_order_relaxed)) {
            boost_wrapper::error_code error;
            tcp::socket socket(context);
            error = acceptor.accept(socket, error);
            if (error == asio::error::would_block || error == asio::error::try_again) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
            if (error) {
                throw boost_wrapper::system_error(error);
            }
            std::thread(handle_session, std::move(socket), initial_workspace_, static_directory_).detach();
        }
    }

}
