FROM nginx:alpine

COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY website/index.html /usr/share/nginx/html/
COPY website/docs.html /usr/share/nginx/html/
COPY website/style.css /usr/share/nginx/html/
COPY website/assets/ /usr/share/nginx/html/assets/
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 80
