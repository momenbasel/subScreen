var getAPItoken = function()
{
    return $(".APIToken").val();
}

let getImage = (key, width, height) => {
    let regex = /^https?:\/\//;
    let url = $('#list_urls').val().split('\n');
    for(let i = 0; i < url.length; i++)
    {
        url[i] = url[i].replace(regex, ''); 
        $(".imageplace").append(`<a href='http://${url[i]}'  target="_blank"><img class='img-fluid' alt="${url[i]}"  src='https://api.urlbox.io/v1/${key}/png?width=${width}&height=${height}&url=${url[i]}'/> </a><p class="domain">${url[i]}</p> <br><br>`);
    }
}



console.log(`

     .d8888b.         888      .d8888b.
    d88P  Y88b        888     d88P  Y88b
    Y88b.             888     Y88b.
     "Y888b.  888  88888888b.  "Y888b.   .d8888b888d888 .d88b.  .d88b. 88888b.
        "Y88b.888  888888 "88b    "Y88b.d88P"   888P"  d8P  Y8bd8P  Y8b888 "88b
          "888888  888888  888      "888888     888    8888888888888888888  888
    Y88b  d88PY88b 888888 d88PY88b  d88PY88b.   888    Y8b.    Y8b.    888  888
     "Y8888P"  "Y8888888888P"  "Y8888P"  "Y8888P888     "Y8888  "Y8888 888  888
                    coded by @momenbassel`);
