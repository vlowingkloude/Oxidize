module;

#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <cstddef>
#include <string>
#include <string_view>
#include <utility>

export module boost_wrapper;

export namespace oxidize::boost_wrapper {
    namespace asio {
        using io_context = ::boost::asio::io_context;

        namespace ip {
            using tcp = ::boost::asio::ip::tcp;
        }

        namespace error {
            inline constexpr auto connection_reset = ::boost::asio::error::connection_reset;
            inline constexpr auto eof = ::boost::asio::error::eof;
            inline constexpr auto try_again = ::boost::asio::error::try_again;
            inline constexpr auto would_block = ::boost::asio::error::would_block;
        }

        namespace socket_base {
            using reuse_address = ::boost::asio::socket_base::reuse_address;
            inline constexpr auto max_listen_connections = ::boost::asio::socket_base::max_listen_connections;
        }
    }

    namespace beast {
        using flat_buffer = ::boost::beast::flat_buffer;
        using role_type = ::boost::beast::role_type;
        using string_view = ::boost::beast::string_view;
        using tcp_stream = ::boost::beast::tcp_stream;

        namespace http {
            using field = ::boost::beast::http::field;
            using status = ::boost::beast::http::status;
            using string_body = ::boost::beast::http::string_body;
            using verb = ::boost::beast::http::verb;

            namespace error {
                inline constexpr auto end_of_stream = ::boost::beast::http::error::end_of_stream;
            }
        }


        namespace websocket::error {
            inline constexpr auto closed = ::boost::beast::websocket::error::closed;
        }
    }

    namespace system {
        using error_code = ::boost::system::error_code;
        using system_error = ::boost::system::system_error;
    }

    using error_code = system::error_code;
    using system_error = system::system_error;
    using FlatBuffer = beast::flat_buffer;
    using TcpStream = beast::tcp_stream;
    using WebSocket = ::boost::beast::websocket::stream<TcpStream>;
    using HttpRequest = ::boost::beast::http::request<::boost::beast::http::string_body>;
    using HttpRequestParser = ::boost::beast::http::request_parser<::boost::beast::http::string_body>;
    using HttpResponse = ::boost::beast::http::response<::boost::beast::http::string_body>;

    struct WebSocketMessage {
        std::string payload;
        bool text;
    };

    WebSocket make_websocket(TcpStream stream) {
        return WebSocket(std::move(stream));
    }

    void configure_websocket(WebSocket &socket, const std::size_t maximum_message_size) {
        socket.set_option(::boost::beast::websocket::stream_base::timeout::suggested(
            ::boost::beast::role_type::server));
        socket.read_message_max(maximum_message_size);
    }

    void accept_websocket(WebSocket &socket, const HttpRequest &request) {
        socket.accept(request);
    }

    bool is_websocket_upgrade(const HttpRequest &request) {
        return ::boost::beast::websocket::is_upgrade(request);
    }

    int websocket_native_handle(WebSocket &socket) {
        return socket.next_layer().socket().native_handle();
    }

    WebSocketMessage read_websocket(WebSocket &socket) {
        FlatBuffer buffer;
        socket.read(buffer);
        return {
            ::boost::beast::buffers_to_string(buffer.data()),
            socket.got_text()
        };
    }

    void write_websocket_text(WebSocket &socket, const std::string_view payload) {
        socket.text(true);
        socket.write(::boost::asio::buffer(payload));
    }

    void read_http(TcpStream &stream, FlatBuffer &buffer, HttpRequestParser &parser, error_code &error) {
        ::boost::beast::http::read(stream, buffer, parser, error);
    }

    void write_http(TcpStream &stream, const HttpResponse &response) {
        ::boost::beast::http::write(stream, response);
    }

    std::string http_verb_string(const beast::http::verb verb) {
        const auto value = ::boost::beast::http::to_string(verb);
        return {value.data(), value.size()};
    }

    std::string http_target_string(const HttpRequest &request) {
        const auto value = request.target();
        return {value.data(), value.size()};
    }
}
